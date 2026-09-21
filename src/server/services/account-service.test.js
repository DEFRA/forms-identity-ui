import { PURPOSE } from '~/src/server/common/constants/purposes.js'
import { verifyOtp } from '~/src/server/lib/identity-api.js'
import {
  submitCode,
  submitEmailCode,
  submitPhoneCode
} from '~/src/server/services/account-service.js'

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
  const code = '123456'

  describe('submitPhoneCode', () => {
    it('should submit for phone and verify successfully', async () => {
      jest.mocked(verifyOtp).mockResolvedValueOnce({ status: 'valid' })
      const res = await submitPhoneCode(uid, code)
      expect(verifyOtp).toHaveBeenCalledWith(
        {
          code: '123456',
          purpose: 'ACCOUNT_VERIFY_PHONE',
          uid: 'uid-1'
        },
        undefined
      )
      expect(res).toEqual({ outcome: 'valid' })
    })
  })

  describe('submitEmailCode', () => {
    it('should submit for email and verify successfully', async () => {
      jest.mocked(verifyOtp).mockResolvedValueOnce({ status: 'valid' })
      const res = await submitEmailCode(uid, code)
      expect(verifyOtp).toHaveBeenCalledWith(
        {
          code: '123456',
          purpose: 'ACCOUNT_VERIFY_EMAIL',
          uid: 'uid-1'
        },
        undefined
      )
      expect(res).toEqual({ outcome: 'valid' })
    })
  })

  describe('submitCode (general)', () => {
    it('should return invalid if code is missing (empty)', async () => {
      const res = await submitCode(uid, '', PURPOSE.ACCOUNT_VERIFY_EMAIL)
      expect(res).toEqual({
        outcome: 'invalid-code',
        errorKey: 'signin.code.errorRequired'
      })
    })

    it('should return invalid if code is missing (undefined)', async () => {
      const res = await submitCode(uid, undefined, PURPOSE.ACCOUNT_VERIFY_EMAIL)
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
        PURPOSE.ACCOUNT_VERIFY_EMAIL
      )
      expect(res).toEqual({
        outcome: 'invalid-code',
        errorKey: 'signin.code.errorInvalidFormat'
      })
    })
  })
})
