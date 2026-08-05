import Boom from '@hapi/boom'

import { getJson, postJson } from '~/src/server/common/helpers/fetch.js'
import {
  completeSignup,
  getAccount,
  getOtpEmail,
  requestOtp,
  verifyOtp
} from '~/src/server/repositories/identity-api.js'

jest.mock('~/src/server/common/helpers/fetch.js', () => ({
  // the transport functions are faked; the Boom-404 predicate stays real
  isNotFoundError: jest.requireActual('~/src/server/common/helpers/fetch.js')
    .isNotFoundError,
  getJson: jest.fn(),
  postJson: jest.fn()
}))

const API = 'http://localhost:3010'

describe('identity-api repository', () => {
  it('requestOtp posts uid and email', async () => {
    jest.mocked(postJson).mockResolvedValue(/** @type {never} */ ({}))

    await requestOtp({ uid: 'uid-1', email: 'a@b.com' })

    const [url, options] = /** @type {[URL, { payload: object }]} */ (
      jest.mocked(postJson).mock.calls[0]
    )
    expect(url.href).toBe(`${API}/otp/request`)
    expect(options.payload).toEqual({ uid: 'uid-1', email: 'a@b.com' })
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

  it('getOtpEmail returns the email, and null on 404', async () => {
    jest
      .mocked(getJson)
      .mockResolvedValue(/** @type {never} */ ({ body: { email: 'a@b.com' } }))
    await expect(getOtpEmail('uid-1')).resolves.toBe('a@b.com')
    expect(jest.mocked(getJson).mock.calls[0][0].href).toBe(`${API}/otp/uid-1`)

    const notFound = Boom.notFound()
    jest.mocked(getJson).mockRejectedValue(notFound)
    await expect(getOtpEmail('uid-none')).resolves.toBeNull()
  })
})
