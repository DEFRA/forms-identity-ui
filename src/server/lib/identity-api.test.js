import Boom from '@hapi/boom'

import { hashId } from '~/src/server/common/helpers/hash-id.js'
import { getJson, postJson } from '~/src/server/lib/identity-api-request.js'
import {
  completeSignup,
  getAccount,
  getOtpEmail,
  requestOtp,
  verifyOtp
} from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'

jest.mock('~/src/server/lib/identity-api-request.js', () => ({
  getJson: jest.fn(),
  postJson: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  getServiceToken: jest.fn()
}))

const API = 'http://localhost:3010'

/**
 * The payload a recorded POST carried
 * @param {number} index
 * @returns {Record<string, string>}
 */
function postPayload(index) {
  const [, , options] =
    /** @type {[URL, string, { payload: Record<string, string> }]} */ (
      jest.mocked(postJson).mock.calls[index]
    )

  return options.payload
}

describe('identity-api client', () => {
  beforeEach(() => {
    jest.mocked(getServiceToken).mockResolvedValue('token-1')
  })

  it('requestOtp posts uid and email', async () => {
    jest.mocked(postJson).mockResolvedValue(/** @type {never} */ ({}))

    await requestOtp({ uid: 'uid-1', email: 'a@b.com' })

    const [url, token, options] =
      /** @type {[URL, string, { payload: object }]} */ (
        jest.mocked(postJson).mock.calls[0]
      )
    expect(url.href).toBe(`${API}/otp/request`)
    expect(token).toBe('token-1')
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

    await expect(verifyOtp({ uid: 'uid-1', code: '123456' })).resolves.toEqual({
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
      completeSignup({ uid: 'uid-1', phone: '07911 123456' })
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

    await requestOtp({ uid: 'uid-1', email: 'a@b.com' })
    await verifyOtp({ uid: 'uid-1', code: '123456' })
    await completeSignup({ uid: 'uid-1', phone: '07911 123456' })
    await getOtpEmail('uid-1')

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

  it('getAccount returns the account, and null on 404', async () => {
    jest.mocked(getJson).mockResolvedValue(
      /** @type {never} */ ({
        body: { id: 'acc-1', email: 'a@b.com' }
      })
    )
    await expect(getAccount('acc-1')).resolves.toEqual({
      id: 'acc-1',
      email: 'a@b.com'
    })

    const notFound = Boom.notFound()
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(getAccount('gone')).resolves.toBeNull()
  })

  it('getAccount rethrows non-404 errors', async () => {
    jest.mocked(getJson).mockRejectedValue(new Error('boom'))
    await expect(getAccount('acc-1')).rejects.toThrow('boom')
  })

  it('makes no request when no token can be minted', async () => {
    jest.mocked(getServiceToken).mockRejectedValue(new Error('STS is down'))

    await expect(getAccount('acc-1')).rejects.toThrow('STS is down')
    expect(getJson).not.toHaveBeenCalled()
  })

  it('getOtpEmail returns the email, and null on 404', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { email: 'a@b.com' } }))
    await expect(getOtpEmail('uid-1')).resolves.toBe('a@b.com')
    expect(jest.mocked(getJson).mock.calls[0][0].href).toBe(
      `${API}/otp/${hashId('uid-1')}`
    )
    expect(jest.mocked(getJson).mock.calls[0][0].href).not.toContain('uid-1')

    const notFound = Boom.notFound()
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(getOtpEmail('uid-none')).resolves.toBeNull()
  })
})
