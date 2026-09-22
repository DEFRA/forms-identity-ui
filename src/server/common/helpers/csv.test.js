import { splitCsv } from '~/src/server/common/helpers/csv.js'

describe('splitCsv', () => {
  it('splits on commas', () => {
    expect(splitCsv('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('trims whitespace around each entry', () => {
    expect(splitCsv(' a , b ')).toEqual(['a', 'b'])
  })

  it('drops empty entries', () => {
    expect(splitCsv(',,,  abc  ,')).toEqual(['abc'])
  })
})
