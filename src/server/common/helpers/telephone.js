import LibPhoneNumber from 'google-libphonenumber'
import JoiBase from 'joi'

/*
 * Joi extension accepting any valid telephone number, defaulting to the UK
 * region when no country code is given. Duplicated between the identity
 * services pending extraction into a shared library.
 */

const phoneUtil = LibPhoneNumber.PhoneNumberUtil.getInstance()

/**
 * The extended string schema (JS port of the original's typed Root)
 * @typedef {JoiBase.StringSchema & { phoneNumber: () => TelephoneSchema }} TelephoneSchema
 */

export const COUNTRY = 'GB'
export const INVALID_ERROR_CODE = 'phoneNumber.invalid'

export const joi = /** @type {JoiBase.Root} */ (
  JoiBase.extend({
    type: 'string',
    base: JoiBase.string(),
    messages: {
      [INVALID_ERROR_CODE]: '{{#label}} must be a telephone number'
    },
    rules: {
      phoneNumber: {
        /**
         * @this {JoiBase.ExtensionBoundSchema}
         */
        method() {
          return this.$_addRule({ name: 'phoneNumber' })
        },
        /**
         * @param {string} value
         * @param {JoiBase.CustomHelpers} helpers
         */
        validate(value, { error }) {
          try {
            const parsed = phoneUtil.parse(value, COUNTRY)

            if (!phoneUtil.isValidNumber(parsed)) {
              return error(INVALID_ERROR_CODE)
            }

            return value
          } catch {
            return error(INVALID_ERROR_CODE)
          }
        }
      }
    }
  })
)
