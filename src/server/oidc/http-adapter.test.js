import Boom from '@hapi/boom'

import {
  delJson,
  getJson,
  postJson,
  putJson
} from '~/src/server/common/helpers/fetch.js'
import { hashId } from '~/src/server/common/helpers/hash-id.js'
import { serviceAuthHeaders } from '~/src/server/lib/service-token.js'
import { makeHttpAdapter } from '~/src/server/oidc/http-adapter.js'

jest.mock('~/src/server/common/helpers/fetch.js', () => ({
  delJson: jest.fn(),
  getJson: jest.fn(),
  postJson: jest.fn(),
  putJson: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  serviceAuthHeaders: jest.fn()
}))

const API = 'http://localhost:3010'
const AUTH_HEADERS = { Authorization: 'Bearer token-1' }

/**
 * A getJson result shaped like the real helper's: a parsed body with its
 * response alongside.
 * @param {unknown} body
 */
function found(body) {
  return /** @type {never} */ ({ response: { statusCode: 200 }, body })
}

/**
 * The API's answer for an artifact it does not hold. Wreck reads a bodiless
 * 204 as an empty Buffer, not null, so only the status distinguishes it.
 */
function absent() {
  return /** @type {never} */ ({
    response: { statusCode: 204 },
    body: Buffer.alloc(0)
  })
}

describe('http adapter', () => {
  const Adapter = makeHttpAdapter()
  const adapter = new Adapter('AuthorizationCode')

  beforeEach(() => {
    jest.mocked(serviceAuthHeaders).mockResolvedValue(AUTH_HEADERS)
  })

  it('snake_cases the model name onto the wire', async () => {
    jest.mocked(putJson).mockResolvedValue(/** @type {never} */ ({}))

    await adapter.upsert('id-1', { foo: 'bar' }, 60)

    const [url, options] =
      /** @type {[URL, { payload: object, headers: object }]} */ (
        jest.mocked(putJson).mock.calls[0]
      )
    expect(options.headers).toEqual(AUTH_HEADERS)
    expect(url.href).toBe(`${API}/oidc/authorization_code/${hashId('id-1')}`)
    expect(url.href).not.toContain('id-1')
    expect(options.payload).toEqual({
      payload: { foo: 'bar' },
      expiresIn: 60
    })
  })

  it.each([
    ['zero', 0],
    ['negative', -30]
  ])(
    'still sends an expiry when the remaining TTL is %s',
    async (_label, remainingTtl) => {
      jest.mocked(putJson).mockResolvedValue(/** @type {never} */ ({}))

      await adapter.upsert('id-exp', { foo: 'bar' }, remainingTtl)

      const [, options] = /** @type {[URL, { payload: object }]} */ (
        jest.mocked(putJson).mock.calls.at(-1)
      )
      // dropping it would tell the API to clear the expiry, leaving an
      // already-expired artifact the TTL sweeper never collects
      expect(options.payload).toEqual({
        payload: { foo: 'bar' },
        expiresIn: 1
      })
    }
  )

  it('omits the expiry only when the provider gives none', async () => {
    jest.mocked(putJson).mockResolvedValue(/** @type {never} */ ({}))

    await adapter.upsert('id-noexp', { foo: 'bar' }, undefined)

    const [, options] = /** @type {[URL, { payload: object }]} */ (
      jest.mocked(putJson).mock.calls.at(-1)
    )
    expect(options.payload).toEqual({ payload: { foo: 'bar' } })
  })

  it('find returns the payload, and undefined on a 204', async () => {
    jest.mocked(getJson).mockResolvedValue(found({ a: 1 }))
    await expect(adapter.find('id-2')).resolves.toEqual({ a: 1 })

    jest.mocked(getJson).mockResolvedValue(absent())
    await expect(adapter.find('missing')).resolves.toBeUndefined()
  })

  it('findByUid returns undefined on a 204', async () => {
    jest.mocked(getJson).mockResolvedValue(absent())
    await expect(adapter.findByUid('nope')).resolves.toBeUndefined()
  })

  it('never mistakes a 204 empty body for a stored payload', async () => {
    // the empty Buffer a bodiless 204 reads back as is truthy, so a body
    // test here would report every miss as a hit holding an empty payload
    jest.mocked(getJson).mockResolvedValue(absent())
    const payload = await adapter.find('missing')

    expect(payload).toBeUndefined()
    expect(payload).not.toEqual(Buffer.alloc(0))
  })

  it('throws on a 404, which the store never answers with', async () => {
    // 204 is the store's only "absent"; a 404 means the route itself is
    // wrong, so it must surface rather than read as a cache miss
    jest.mocked(getJson).mockRejectedValue(Boom.notFound())
    await expect(adapter.find('missing')).rejects.toThrow('Not Found')
    await expect(adapter.findByUid('missing')).rejects.toThrow('Not Found')
  })

  it('find propagates transport errors', async () => {
    jest.mocked(getJson).mockRejectedValue(new Error('boom'))
    await expect(adapter.find('id-3')).rejects.toThrow('boom')
  })

  it('find addresses the artifact by its digest', async () => {
    jest.mocked(getJson).mockResolvedValue(found({ a: 1 }))

    await adapter.find('id-find')

    expect(jest.mocked(getJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/authorization_code/${hashId('id-find')}`
    )
  })

  it('consume, destroy and findByUserCode address the artifact by its digest', async () => {
    jest.mocked(getJson).mockResolvedValue(found({ a: 1 }))
    jest.mocked(postJson).mockResolvedValue(/** @type {never} */ ({}))
    jest.mocked(delJson).mockResolvedValue(/** @type {never} */ ({}))

    await adapter.consume('id-4')
    expect(jest.mocked(postJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/authorization_code/${hashId('id-4')}/consume`
    )

    await adapter.destroy('id-5')
    expect(jest.mocked(delJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/authorization_code/${hashId('id-5')}`
    )

    // device flow delegates to find, so the user code is hashed too
    await adapter.findByUserCode('id-6')
    expect(jest.mocked(getJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/authorization_code/${hashId('id-6')}`
    )

    const paths = [
      ...jest.mocked(postJson).mock.calls,
      ...jest.mocked(delJson).mock.calls,
      ...jest.mocked(getJson).mock.calls
    ].map((call) => call[0].href)
    expect(paths.join(' ')).not.toMatch(/id-[456]/)
  })

  it('findByUid and revokeByGrantId send the plaintext value, encoded', async () => {
    jest.mocked(getJson).mockResolvedValue(found({ uid: 'u' }))
    jest.mocked(delJson).mockResolvedValue(/** @type {never} */ ({}))

    // both resolve against a value the adapter stores verbatim inside the
    // payload, so a digest here would never match
    const session = new Adapter('Session')
    await session.findByUid('u-1')
    expect(jest.mocked(getJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/session/uid/u-1`
    )

    await adapter.revokeByGrantId('g-1')
    expect(jest.mocked(delJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/grants/g-1`
    )
  })

  it('makes no request when no token can be retrieved', async () => {
    jest.mocked(serviceAuthHeaders).mockRejectedValue(new Error('STS is down'))

    await expect(adapter.find('id-7')).rejects.toThrow('STS is down')
    expect(getJson).not.toHaveBeenCalled()
  })

  it('keeps a traversal attempt inside the /oidc route family', async () => {
    jest.mocked(getJson).mockResolvedValue(found({ uid: 'u' }))
    jest.mocked(delJson).mockResolvedValue(/** @type {never} */ ({}))

    const session = new Adapter('Session')
    await session.findByUid('../../accounts/1')
    expect(jest.mocked(getJson).mock.calls.at(-1)?.[0].pathname).toBe(
      '/oidc/session/uid/..%2F..%2Faccounts%2F1'
    )

    await adapter.revokeByGrantId('../../accounts/1')
    expect(jest.mocked(delJson).mock.calls.at(-1)?.[0].pathname).toBe(
      '/oidc/grants/..%2F..%2Faccounts%2F1'
    )
  })
})
