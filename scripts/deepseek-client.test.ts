import { describe, expect, it, vi } from 'vitest'
import { callDeepSeekCompletion } from './deepseek-client.mjs'

describe('DeepSeek structured completion', () => {
  it('disables thinking and retries an empty JSON response', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }], usage: { completion_tokens: 4000 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"claims":[]}' } }], usage: { completion_tokens: 8 } })))

    const result = await callDeepSeekCompletion({ apiKey: 'fixture-key', model: 'deepseek-v4-flash', prompt: 'Return JSON claims', maxTokens: 4000, structured: true, fetchImpl })

    expect(result.text).toBe('{"claims":[]}')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const firstRequest = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(firstRequest).toMatchObject({
      model: 'deepseek-v4-flash', max_tokens: 4000,
      response_format: { type: 'json_object' }, thinking: { type: 'disabled' },
    })
    expect(firstRequest.messages[0].content).toMatch(/exactly one valid JSON object/i)
    const secondRequest = JSON.parse(fetchImpl.mock.calls[1][1].body)
    expect(secondRequest.messages.at(-1).content).toMatch(/Return the JSON object now/)
  })

  it('reports the final empty-response diagnostics', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: null } }], usage: { completion_tokens: 4000 } })))
    await expect(callDeepSeekCompletion({ apiKey: 'fixture-key', model: 'deepseek-v4-flash', prompt: 'JSON', maxTokens: 4000, structured: true, fetchImpl }))
      .rejects.toThrow('empty content after 3 attempts (finish reason: length, completion tokens: 4000)')
  })

  it('falls back to a strict JSON prompt without JSON mode after two empty responses', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '' } }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"claims":[]}' } }] })))

    const result = await callDeepSeekCompletion({ apiKey: 'fixture-key', model: 'deepseek-v4-flash', prompt: 'Return JSON claims', maxTokens: 4000, structured: true, fetchImpl })

    expect(result.text).toBe('{"claims":[]}')
    const fallbackRequest = JSON.parse(fetchImpl.mock.calls[2][1].body)
    expect(fallbackRequest.response_format).toBeUndefined()
    expect(fallbackRequest.messages.at(-1).content).toMatch(/If there are no matching claims/)
  })
})
