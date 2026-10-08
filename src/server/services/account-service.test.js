import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { verifyOtp } from '~/src/server/lib/identity-api.js'
import { submitCode } from '~/src/server/services/account-service.js'

jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtpViaEmail: jest.fn(),
  requestOtpViaSms: jest.fn(),
  verifyOtp: jest.fn(),
  getAccount: jest.fn(),
  getOtpTarget: jest.fn(),
  getOtp: jest.fn()
}))

jest.mock('~/src/server/lib/service-token.js', () => ({
  ...jest.requireActual('~/src/server/lib/service-token.js'),
  getServiceToken: jest.fn()
}))

describe('account service', () => {
  const uid = 'uid-1'

  describe('submitCode (general)', () => {
    it('should return invalid if code is missing (empty)', async () => {
      const res = await submitCode(
        uid,
        '',
        PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL
      )
      expect(res).toEqual({
        outcome: 'invalid-code',
        errorKey: 'signin.code.errorRequired'
      })
    })

    it('should return invalid if code is missing (undefined)', async () => {
      const res = await submitCode(
        uid,
        undefined,
        PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL
      )
      expect(res).toEqual({
        outcome: 'invalid-code',
        errorKey: 'signin.code.errorRequired'
      })
    })

    it('should return invalid if code is wrong format', async () => {
      jest
        .mocked(verifyOtp)
        .mockResolvedValueOnce({ status: 'invalid-code-format' })
      const res = await submitCode(
        uid,
        'invalid-format',
        PURPOSE.ACCOUNT_CHANGE_EMAIL_VERIFY_EMAIL
      )
      expect(res).toEqual({
        outcome: 'invalid-code',
        errorKey: 'signin.code.errorInvalidFormat'
      })
    })
  })
})
