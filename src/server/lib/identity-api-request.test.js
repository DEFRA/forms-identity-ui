import * as fetch from '~/src/server/common/helpers/fetch.js'
import {
  delJson,
  getJson,
  postJson,
  putJson
} from '~/src/server/lib/identity-api-request.js'

jest.mock('~/src/server/common/helpers/fetch.js', () => ({
  getJson: jest.fn(),
  postJson: jest.fn(),
  putJson: jest.fn(),
  delJson: jest.fn()
}))

const url = new URL('http://identity-api.test/otp/request')

describe('identity-api-request', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each([
    ['getJson', getJson, fetch.getJson],
    ['postJson', postJson, fetch.postJson],
    ['putJson', putJson, fetch.putJson],
    ['delJson', delJson, fetch.delJson]
  ])('%s carries the caller token', async (_name, verb, underlying) => {
    await verb(url, 'token-1')

    expect(underlying).toHaveBeenCalledWith(url, {
      headers: { Authorization: 'Bearer token-1' }
    })
  })

  it('keeps the caller options and adds the header', async () => {
    await postJson(url, 'token-1', { payload: { uid: 'uid-1' } })

    expect(fetch.postJson).toHaveBeenCalledWith(url, {
      payload: { uid: 'uid-1' },
      headers: { Authorization: 'Bearer token-1' }
    })
  })

  it('keeps caller headers alongside the token', async () => {
    await getJson(url, 'token-1', { headers: { 'x-trace-id': 'trace-1' } })

    expect(fetch.getJson).toHaveBeenCalledWith(url, {
      headers: { 'x-trace-id': 'trace-1', Authorization: 'Bearer token-1' }
    })
  })

  it('overrides a caller-supplied Authorization header with the token', async () => {
    await getJson(url, 'token-1', {
      headers: { Authorization: 'Bearer caller-supplied' }
    })

    expect(fetch.getJson).toHaveBeenCalledWith(url, {
      headers: { Authorization: 'Bearer token-1' }
    })
  })
})
