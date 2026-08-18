import Boom from '@hapi/boom'

import { hashId } from '~/src/server/common/helpers/hash-id.js'
import {
  delJson,
  getJson,
  postJson,
  putJson
} from '~/src/server/lib/identity-api-request.js'
import { makeHttpAdapter } from '~/src/server/oidc/http-adapter.js'

jest.mock('~/src/server/lib/identity-api-request.js', () => ({
  delJson: jest.fn(),
  getJson: jest.fn(),
  postJson: jest.fn(),
  putJson: jest.fn()
}))

const API = 'http://localhost:3010'

describe('http adapter', () => {
  const Adapter = makeHttpAdapter()
  const adapter = new Adapter('AuthorizationCode')

  it('snake_cases the model name onto the wire', async () => {
    jest.mocked(putJson).mockResolvedValue(/** @type {never} */ ({}))

    await adapter.upsert('id-1', { foo: 'bar' }, 60)

    const [url, options] = /** @type {[URL, { payload: object }]} */ (
      jest.mocked(putJson).mock.calls[0]
    )
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

  it('find returns the payload, and undefined on 404', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { a: 1 } }))
    await expect(adapter.find('id-2')).resolves.toEqual({ a: 1 })

    const notFound = Boom.notFound()
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(adapter.find('missing')).resolves.toBeUndefined()
  })

  it('find rethrows non-404 errors', async () => {
    jest.mocked(getJson).mockRejectedValue(new Error('boom'))
    await expect(adapter.find('id-3')).rejects.toThrow('boom')
  })

  it('find addresses the artifact by its digest', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { a: 1 } }))

    await adapter.find('id-find')

    expect(jest.mocked(getJson).mock.calls.at(-1)?.[0].href).toBe(
      `${API}/oidc/authorization_code/${hashId('id-find')}`
    )
  })

  it('consume, destroy and findByUserCode address the artifact by its digest', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { a: 1 } }))
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
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { uid: 'u' } }))
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

  it('keeps a traversal attempt inside the /oidc route family', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { uid: 'u' } }))
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
