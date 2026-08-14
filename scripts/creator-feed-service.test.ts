import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addCreatorSource, getCreatorVideoDetail, listCreatorSources, normalizeYoutubeSource, parseYoutubeFeed, pollCreatorSources, processCreatorQueue, retryCreatorVideo, transcriptForPrompt } from './creator-feed-service.mjs'
import { migrateDatabase } from './db-migrate.mjs'
import { closeDb, getDb } from './db.mjs'

const directories: string[] = []
afterEach(async () => {
  await closeDb()
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true })
})

describe('native YouTube creator feeds', () => {
  it('normalizes channel IDs and feed URLs', () => {
    expect(normalizeYoutubeSource('UC1234567890123456789012')).toEqual({ channelId: 'UC1234567890123456789012', feedUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC1234567890123456789012' })
    expect(normalizeYoutubeSource('https://youtube.com/channel/UCabcdefghijklmnopqrstuv')).toMatchObject({ channelId: 'UCabcdefghijklmnopqrstuv' })
    expect(() => normalizeYoutubeSource('https://youtube.com/@handle')).toThrow(/channel ID/)
  })

  it('parses timestamped Atom entries', () => {
    const feed = parseYoutubeFeed(`<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>FPL Creator</title><entry><yt:videoId>abc123XYZ_0</yt:videoId><title>GW1 &amp; captaincy</title><link rel="alternate" href="https://www.youtube.com/watch?v=abc123XYZ_0"/><published>2026-08-13T10:00:00Z</published></entry></feed>`)
    expect(feed).toEqual({ sourceName: 'FPL Creator', entries: [{ videoId: 'abc123XYZ_0', title: 'GW1 & captaincy', url: 'https://www.youtube.com/watch?v=abc123XYZ_0', publishedAt: '2026-08-13T10:00:00Z' }] })
  })

  it('uses validators and skips unchanged YouTube feeds', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-cache-'))
    directories.push(directory)
    const database = path.join(directory, 'feed.sqlite')
    await migrateDatabase(database)
    const db = getDb(database)
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Cached Creator</title></feed>`
    await addCreatorSource(db, { channelId: 'UC1234567890123456789012' }, async () => new Response(xml, { headers: { etag: '"v1"', 'last-modified': 'Thu, 13 Aug 2026 10:00:00 GMT' } }))
    let requestHeaders
    await pollCreatorSources(db, async (_url, init) => {
      requestHeaders = init?.headers
      return new Response(null, { status: 304 })
    })
    expect(requestHeaders).toMatchObject({ 'if-none-match': '"v1"', 'if-modified-since': 'Thu, 13 Aug 2026 10:00:00 GMT' })
    expect((await listCreatorSources(db)).sources[0]).toMatchObject({ name: 'Cached Creator' })
  })

  it('preserves timestamps and bounds transcript prompt size', () => {
    expect(transcriptForPrompt([{ start: 1.4, text: ' Salah   starts ' }, { start: 62, text: 'captain him' }])).toBe('[1s] Salah starts\n[62s] captain him')
    expect(transcriptForPrompt([{ start: 0, text: '123456789' }], 8)).toBe('')
  })

  it('durably queues and completes newly discovered videos', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-feed-'))
    directories.push(directory)
    const database = path.join(directory, 'feed.sqlite')
    await migrateDatabase(database)
    const db = getDb(database)
    const existingXml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title><entry><yt:videoId>oldVideo123</yt:videoId><title>Old upload</title><published>2026-08-13T10:00:00Z</published></entry></feed>`
    await addCreatorSource(db, { channelId: 'UC1234567890123456789012' }, async () => new Response(existingXml))
    expect(await listCreatorSources(db)).toMatchObject({ sources: [{ name: 'Test Creator' }], videos: [] })
    expect(await pollCreatorSources(db, async () => new Response(existingXml))).toMatchObject({ discovered: 0 })

    const newXml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title><entry><yt:videoId>videoABC123</yt:videoId><title>GW1 roles</title><published>2099-08-13T10:00:00Z</published></entry><entry><yt:videoId>oldVideo123</yt:videoId><title>Old upload</title><published>2026-08-13T10:00:00Z</published></entry></feed>`
    expect(await pollCreatorSources(db, async () => new Response(newXml))).toMatchObject({ discovered: 1 })
    expect(await listCreatorSources(db)).toMatchObject({ videos: [{ id: 'videoABC123', status: 'DISCOVERED' }] })

    const result = await processCreatorQueue(db, {
      transcriptFetcher: async () => ({ status: 'ok', languageCode: 'en', isGenerated: true, segments: [{ text: 'Salah will start', start: 12, duration: 2 }] }),
      extractClaims: async ({ video }: any) => ({ provider: 'fixture', payload: { source: { externalId: video.id }, claims: [{ rawPlayerName: 'Salah', summary: 'Will start' }] }, ingest: async () => ({ created: 1 }) }),
    })
    expect(result).toMatchObject({ processed: 1, completed: 1, claims: 1 })
    expect((await listCreatorSources(db)).videos[0]).toMatchObject({ status: 'COMPLETE', claimCount: 1 })
    expect(await getCreatorVideoDetail(db, 'videoABC123')).toMatchObject({
      status: 'COMPLETE', transcriptLanguage: 'en', transcriptGenerated: true,
      transcript: [{ text: 'Salah will start', start: 12, duration: 2 }],
      extractionProvider: 'fixture', claimCount: 1,
    })
    expect(await getCreatorVideoDetail(db, 'missing')).toBeNull()
  })

  it('allows failed and delayed videos to be retried immediately', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-retry-'))
    directories.push(directory)
    const database = path.join(directory, 'feed.sqlite')
    await migrateDatabase(database)
    const db = getDb(database)
    const baselineXml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title></feed>`
    await addCreatorSource(db, { channelId: 'UC1234567890123456789012' }, async () => new Response(baselineXml))
    const newXml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title><entry><yt:videoId>retryABC123</yt:videoId><title>Retry me</title><published>2099-08-13T10:00:00Z</published></entry></feed>`
    await pollCreatorSources(db, async () => new Response(newXml))
    await db.query(`UPDATE "CreatorVideo" SET "status"='RETRY',"next_attempt_at"='2099-01-01T00:00:00Z',"last_error"='Old provider error' WHERE "id"=$1`, ['retryABC123'])
    await retryCreatorVideo(db, 'retryABC123')
    expect(await getCreatorVideoDetail(db, 'retryABC123')).toMatchObject({ status: 'DISCOVERED', error: null })
    await expect(retryCreatorVideo(db, 'retryABC123')).rejects.toThrow(/cannot be retried/)
  })

  it('retains fetched captions when claim extraction must be retried', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-captions-'))
    directories.push(directory)
    const database = path.join(directory, 'feed.sqlite')
    await migrateDatabase(database)
    const db = getDb(database)
    await addCreatorSource(db, { channelId: 'UC1234567890123456789012' }, async () => new Response('<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title></feed>'))
    await pollCreatorSources(db, async () => new Response('<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title><entry><yt:videoId>captionsABC123</yt:videoId><title>Keep captions</title><published>2099-08-13T10:00:00Z</published></entry></feed>'))

    await processCreatorQueue(db, {
      transcriptFetcher: async () => ({ status: 'ok', languageCode: 'en', isGenerated: false, segments: [{ text: 'Salah starts', start: 12, duration: 2 }] }),
      extractClaims: async () => { throw new Error('Provider temporarily returned empty content') },
    })

    expect(await getCreatorVideoDetail(db, 'captionsABC123')).toMatchObject({
      status: 'RETRY', transcriptLanguage: 'en', transcriptGenerated: false,
      transcript: [{ text: 'Salah starts', start: 12, duration: 2 }],
    })
  })
})
