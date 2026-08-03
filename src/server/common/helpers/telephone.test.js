import { joi } from '~/src/server/common/helpers/telephone.js'

const schema =
  /** @type {import('~/src/server/common/helpers/telephone.js').TelephoneSchema} */ (
    joi.string()
  )
    .phoneNumber()
    .required()

describe('telephone joi extension (engine-plugin port)', () => {
  it.each([
    ['07911 123456'], // UK-plan mobile, national format
    ['+44 7911 123456'],
    ['020 7946 0000'], // UK landline — a real number, so the rule accepts it
    ['+33 6 12 34 56 78'] // international mobile
  ])('accepts %s', (value) => {
    expect(schema.validate(value).error).toBeUndefined()
  })

  it.each([['not a number'], ['07700'], ['']])('rejects %s', (value) => {
    expect(schema.validate(value).error).toBeDefined()
  })
})
