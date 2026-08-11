const SECRET_PATTERN = /((?:authorization|api[-_ ]?key|token|secret|password)\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi
const BEARER_PATTERN = /Bearer\s+[^\s,;]+/gi

export const MAX_JSON_BODY_BYTES = 1_000_000

export function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(SECRET_PATTERN, '$1[REDACTED]')
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]+/gi, '[URL_REDACTED]')
    .slice(0, 500)
}

export class HttpRequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export function requireJsonContentType(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new HttpRequestError(415, 'Content-Type must be application/json')
  }
}

export function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  requireJsonContentType(req)
  return new Promise((resolve, reject) => {
    const chunks = []
    let bytes = 0
    let settled = false
    const rejectOnce = error => {
      if (!settled) {
        settled = true
        reject(error)
      }
    }
    req.on('data', chunk => {
      bytes += chunk.length
      if (bytes > maxBytes) {
        req.resume()
        rejectOnce(new HttpRequestError(413, 'Request body too large'))
        return
      }
      if (!settled) chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const payload = JSON.parse(raw || '{}')
        settled = true
        resolve(payload)
      } catch {
        rejectOnce(new HttpRequestError(400, 'Request body must be valid JSON'))
      }
    })
    req.on('error', () => rejectOnce(new HttpRequestError(400, 'Request body could not be read')))
  })
}
