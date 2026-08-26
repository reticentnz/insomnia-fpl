import { describe, expect, it } from 'vitest'
import { parseCsv } from './ingest-historical-priors.mjs'

describe('historical-prior archive parsing', () => {
  it('retains quoted FPL archive values and maps rows by their header', () => {
    const rows = parseCsv('web_name,minutes,bonus\n"A, Player",1234,18\n')
    expect(rows).toEqual([{ web_name: 'A, Player', minutes: '1234', bonus: '18' }])
  })
})
