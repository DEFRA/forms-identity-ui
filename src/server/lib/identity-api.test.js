import Boom from '@hapi/boom'

import { getJson, postJson } from '~/src/server/common/helpers/fetch.js'
import { hashId } from '~/src/server/common/helpers/hash-id.js'
import {
  completeSignup,
  getAccount,
  getOtpEmail,
  requestOtp,
  verifyOtp
} from '~/src/server/lib/identity-api.js'

jest.mock('~/src/server/common/helpers/fetch.js', () => ({
  ...jest.requireActual('~/src/server/common/helpers/fetch.js'),
  getJson: jest.fn(),
  postJson: jest.fn()
}))

const API = 'http://localhost:3010'
const AUTH_HEADERS = { Authorization: 'Bearer token-1' }

/**
 * The payload a recorded POST carried
 * @param {number} index
 * @returns {Record<string, string>}
 */
function postPayload(index) {
  const [, options] =
    /** @type {[URL, { payload: Record<string, string> }]} */ (
      jest.mocked(postJson).mock.calls[index]
    )

  return options.payload
}

describe('identity-api client', () => {
  it('requestOtp posts uid and email', async () => {
    jest.mocked(postJson).mockResolvedValue(/** @type {never} */ ({}))

    await requestOtp({ uid: 'uid-1', email: 'a@b.com' }, 'token-1')

    const [url, options] =
      /** @type {[URL, { payload: object, headers: object }]} */ (
        jest.mocked(postJson).mock.calls[0]
      )
    expect(url.href).toBe(`${API}/otp/request`)
    expect(options.headers).toEqual(AUTH_HEADERS)
    expect(options.payload).toEqual({
      uid: hashId('uid-1'),
      email: 'a@b.com'
    })
  })

  it('verifyOtp returns the verdict body', async () => {
    jest
      .mocked(postJson)
      .mockResolvedValue(
        /** @type {never} */ ({ body: { status: 'phone-required' } })
      )

    await expect(
      verifyOtp({ uid: 'uid-1', code: '123456' }, 'token-1')
    ).resolves.toEqual({
      status: 'phone-required'
    })
    expect(jest.mocked(postJson).mock.calls[0][0].href).toBe(
      `${API}/otp/verify`
    )
    expect(postPayload(0)).toEqual({
      uid: hashId('uid-1'),
      code: '123456'
    })
  })

  it('completeSignup returns the verdict body', async () => {
    jest.mocked(postJson).mockResolvedValue(
      /** @type {never} */ ({
        body: { status: 'signed-in', accountId: 'acc-1' }
      })
    )

    await expect(
      completeSignup({ uid: 'uid-1', phone: '07911 123456' }, 'token-1')
    ).resolves.toEqual({ status: 'signed-in', accountId: 'acc-1' })
    expect(jest.mocked(postJson).mock.calls[0][0].href).toBe(`${API}/accounts`)
    expect(postPayload(0)).toEqual({
      uid: hashId('uid-1'),
      phone: '07911 123456'
    })
  })

  it('keys the OTP record the same way at all four call sites', async () => {
    jest.mocked(postJson).mockResolvedValue(/** @type {never} */ ({ body: {} }))
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { email: 'a@b.com' } }))

    await requestOtp({ uid: 'uid-1', email: 'a@b.com' }, 'token-1')
    await verifyOtp({ uid: 'uid-1', code: '123456' }, 'token-1')
    await completeSignup({ uid: 'uid-1', phone: '07911 123456' }, 'token-1')
    await getOtpEmail('uid-1', 'token-1')

    // one plaintext uid among them would make the API's {uid, purpose}
    // lookup miss, which surfaces as a 404 rather than an error
    const sent = [
      postPayload(0).uid,
      postPayload(1).uid,
      postPayload(2).uid,
      jest.mocked(getJson).mock.calls[0][0].pathname.split('/')[2]
    ]
    expect(sent).toEqual(Array(4).fill(hashId('uid-1')))
  })

  it('every call carries the caller credential', async () => {
    jest.mocked(postJson).mockResolvedValue(/** @type {never} */ ({ body: {} }))
    jest
      .mocked(getJson)
      .mockResolvedValue(
        /** @type {never} */ ({ body: { email: 'a@b.com', id: 'acc-1' } })
      )

    await requestOtp({ uid: 'uid-1', email: 'a@b.com' }, 'token-1')
    await verifyOtp({ uid: 'uid-1', code: '123456' }, 'token-1')
    await completeSignup({ uid: 'uid-1', phone: '07911 123456' }, 'token-1')
    await getOtpEmail('uid-1', 'token-1')
    await getAccount('acc-1', 'token-1')

    const calls = [
      ...jest.mocked(postJson).mock.calls,
      ...jest.mocked(getJson).mock.calls
    ]
    expect(calls).toHaveLength(5)
    for (const [, options] of calls) {
      expect(options.headers).toEqual(AUTH_HEADERS)
    }
  })

  it('getAccount returns the account, and null on 404', async () => {
    jest.mocked(getJson).mockResolvedValue(
      /** @type {never} */ ({
        body: { id: 'acc-1', email: 'a@b.com' }
      })
    )
    await expect(getAccount('acc-1', 'token-1')).resolves.toEqual({
      id: 'acc-1',
      email: 'a@b.com'
    })

    const notFound = Boom.notFound()
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(getAccount('gone', 'token-1')).resolves.toBeNull()
  })

  it('getAccount rethrows non-404 errors', async () => {
    jest.mocked(getJson).mockRejectedValue(new Error('boom'))
    await expect(getAccount('acc-1', 'token-1')).rejects.toThrow('boom')
  })

  it('getOtpEmail returns the email, and null on 404', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { email: 'a@b.com' } }))
    await expect(getOtpEmail('uid-1', 'token-1')).resolves.toBe('a@b.com')
    expect(jest.mocked(getJson).mock.calls[0][0].href).toBe(
      `${API}/otp/${hashId('uid-1')}`
    )
    expect(jest.mocked(getJson).mock.calls[0][0].href).not.toContain('uid-1')

    const notFound = Boom.notFound()
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(getOtpEmail('uid-none', 'token-1')).resolves.toBeNull()
  })
})
