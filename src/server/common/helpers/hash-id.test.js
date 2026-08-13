import { hashId } from '~/src/server/common/helpers/hash-id.js'

describe('hashId', () => {
  it('is deterministic, so a digest works as a storage key', () => {
    expect(hashId('id-1')).toBe(hashId('id-1'))
    expect(hashId('id-1')).not.toBe(hashId('id-2'))
  })

  it('produces a base64url digest that is safe in a path segment', () => {
    // an unpadded 256-bit digest is 43 characters of [A-Za-z0-9_-], so it
    // can never carry `/`, `.` or anything else that changes the route
    expect(hashId('id-1')).toMatch(/^[\w-]{43}$/)
  })

  it('hides the input', () => {
    expect(hashId('K5eGpDlBDwXjQmXpZm2CxA9d')).not.toContain('K5eGp')
  })
})
