import { csvFormat, optionalCsvFormat } from '~/src/config/csv-format.js'

describe('csv format', () => {
  describe('coerce', () => {
    it('splits on commas', () => {
      expect(csvFormat.coerce?.('a,b,c')).toEqual(['a', 'b', 'c'])
    })

    it('trims whitespace around each entry', () => {
      expect(csvFormat.coerce?.(' a , b ')).toEqual(['a', 'b'])
    })

    it('drops empty entries', () => {
      expect(csvFormat.coerce?.(',,,  abc  ,')).toEqual(['abc'])
    })
  })

  describe('validate', () => {
    it('accepts a list of strings', () => {
      expect(() =>
        csvFormat.validate?.(['a', 'b'], { default: null })
      ).not.toThrow()
    })

    it.each([
      ['a missing value', null],
      ['an empty list', []],
      ['a list with a non-string entry', ['a', 1]],
      ['a plain string', 'a,b']
    ])('rejects %s', (_name, value) => {
      expect(() => csvFormat.validate?.(value, { default: null })).toThrow(
        'must be a comma-separated list with at least one entry'
      )
    })
  })
})

describe('optional csv format', () => {
  it('reads an empty value as an empty list', () => {
    expect(optionalCsvFormat.coerce?.(' , ')).toEqual([])
  })

  it('splits on commas and trims each entry', () => {
    expect(optionalCsvFormat.coerce?.(' a ,, b ')).toEqual(['a', 'b'])
  })

  it.each([
    ['an empty list', []],
    ['a list of strings', ['a', 'b']]
  ])('accepts %s', (_name, value) => {
    expect(() =>
      optionalCsvFormat.validate?.(value, { default: null })
    ).not.toThrow()
  })

  it.each([
    ['a missing value', null],
    ['a list with a non-string entry', ['a', 1]],
    ['a plain string', 'a,b']
  ])('rejects %s', (_name, value) => {
    expect(() =>
      optionalCsvFormat.validate?.(value, { default: null })
    ).toThrow('must be a comma-separated list')
  })
})
