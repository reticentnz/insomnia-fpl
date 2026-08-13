import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addCreatorSource, getCreatorVideoDetail, listCreatorSources, normalizeYoutubeSource, parseYoutubeFeed, processCreatorQueue, transcriptForPrompt } from './creator-feed-service.mjs'
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
    const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><title>Test Creator</title><entry><yt:videoId>videoABC123</yt:videoId><title>GW1 roles</title><published>2026-08-13T10:00:00Z</published></entry></feed>`
    await addCreatorSource(db, { channelId: 'UC1234567890123456789012' }, async () => new Response(xml))
    expect(await listCreatorSources(db)).toMatchObject({ sources: [{ name: 'Test Creator' }], videos: [{ id: 'videoABC123', status: 'DISCOVERED' }] })

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
})
