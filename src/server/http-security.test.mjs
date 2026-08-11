import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { HttpRequestError, MAX_JSON_BODY_BYTES, readJsonBody, sanitizeError } from './http-security.mjs'

function request(headers, chunks) {
  const stream = new PassThrough()
  stream.headers = headers
  queueMicrotask(() => {
    for (const chunk of chunks) stream.write(chunk)
    stream.end()
  })
  return stream
}

describe('HTTP security boundaries', () => {
  it('redacts provider keys and authorization values from errors', () => {
    expect(sanitizeError('authorization: Bearer secret-value apiKey=abc123 https://example.test/?token=xyz'))
      .toBe('authorization: [REDACTED] apiKey=[REDACTED] [URL_REDACTED]')
  })

  it('requires JSON request content', async () => {
    expect(() => readJsonBody(request({ 'content-type': 'text/plain' }, ['{}']))).toThrow(HttpRequestError)
  })

  it('rejects oversized JSON payloads with 413', async () => {
    await expect(readJsonBody(request({ 'content-type': 'application/json' }, ['x'.repeat(MAX_JSON_BODY_BYTES + 1)])))
      .rejects.toMatchObject({ status: 413 })
  })

  it('uses a safe validation error for malformed JSON', async () => {
    await expect(readJsonBody(request({ 'content-type': 'application/json' }, ['{']))).rejects.toMatchObject({ status: 400 })
  })
})
