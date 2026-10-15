import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import * as identityApi from '~/src/server/lib/identity-api.js'
import {
  requestOtpViaEmail,
  requestOtpViaSms
} from '~/src/server/services/otp-service.js'

jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtpViaEmail: jest.fn(),
  requestOtpViaSms: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  getServiceToken: jest.fn().mockResolvedValue('token')
}))

describe('otp service', () => {
  const uid = 'uid-1'
  const accountId = 'acc-1'
  const purpose = PURPOSE.ACCOUNT_DELETE_ACCOUNT_VERIFY_EMAIL
  const lockedUntil = '2026-10-15T11:00:00.000Z'

  describe.each([
    [
      'requestOtpViaEmail',
      () => requestOtpViaEmail(uid, 'a@example.com', purpose, accountId),
      () => jest.mocked(identityApi.requestOtpViaEmail),
      { outcome: 'code-sent', email: 'a@example.com' }
    ],
    [
      'requestOtpViaSms',
      () => requestOtpViaSms(uid, purpose, accountId),
      () => jest.mocked(identityApi.requestOtpViaSms),
      { outcome: 'code-sent' }
    ]
  ])('%s', (_name, call, api, sent) => {
    it('returns code-sent when the API issues a code', async () => {
      api().mockResolvedValue({ status: 'otp-issued' })

      await expect(call()).resolves.toEqual(sent)
    })

    it('returns locked-out with the lockout end as a Date', async () => {
      api().mockResolvedValue({ status: 'locked-out', lockedUntil })

      await expect(call()).resolves.toEqual({
        outcome: 'locked-out',
        lockedUntil: new Date(lockedUntil)
      })
    })

    it('throws on an unexpected status', async () => {
      // @ts-expect-error - invalid property for testing
      api().mockResolvedValue({ status: 'surprise' })

      await expect(call()).rejects.toThrow(
        'Unexpected code request status: surprise'
      )
    })
  })
})
