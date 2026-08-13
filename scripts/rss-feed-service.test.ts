import { describe, expect, it } from 'vitest'
import { normalizeRssSource, parseRssFeed } from './rss-feed-service.mjs'

describe('RSS feed service', () => {
  it('parses supplied RSS item text without fetching an article', () => {
    const feed = parseRssFeed(`<?xml version="1.0"?><rss><channel><title>Club news</title><item><guid>club-1</guid><title>Team update</title><link>https://club.example/news/team-update</link><pubDate>Wed, 14 Aug 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>Alex Player has returned to training.</p>]]></description></item></channel></rss>`)
    expect(feed.sourceName).toBe('Club news')
    expect(feed.entries).toEqual([expect.objectContaining({ externalId: 'club-1', title: 'Team update', url: 'https://club.example/news/team-update', contentText: 'Alex Player has returned to training.' })])
  })

  it('allows public http(s) feeds and rejects local targets', () => {
    expect(normalizeRssSource('https://publisher.example/rss.xml#latest')).toBe('https://publisher.example/rss.xml')
    expect(() => normalizeRssSource('http://127.0.0.1/feed.xml')).toThrow('public hostname')
  })

  it('uses a stable item identifier so an unchanged headline is deduplicated by its feed GUID', () => {
    const xml = `<rss><channel><title>Publisher</title><item><guid>stable-item-id</guid><title>Same headline</title><description>Enough supplied evidence to be stored.</description></item></channel></rss>`
    expect(parseRssFeed(xml).entries[0]?.externalId).toBe('stable-item-id')
  })
})
