import Wreck from '@hapi/wreck'

import { getJson, postJson } from '~/src/server/common/helpers/fetch.js'

jest.mock('@hapi/wreck')

describe('fetch helpers', () => {
  it('returns the parsed body on 2xx', async () => {
    jest
      .mocked(Wreck.request)
      .mockResolvedValue(/** @type {never} */ ({ statusCode: 200 }))
    jest
      .mocked(Wreck.read)
      .mockResolvedValue(/** @type {never} */ ({ hello: 'world' }))

    const { body } = await getJson(new URL('http://localhost:3010/x'))

    expect(body).toEqual({ hello: 'world' })
  })

  it('throws Boom on non-2xx with the body message', async () => {
    jest
      .mocked(Wreck.request)
      .mockResolvedValue(/** @type {never} */ ({ statusCode: 404 }))
    jest
      .mocked(Wreck.read)
      .mockResolvedValue(/** @type {never} */ ({ message: 'Not Found' }))

    await expect(
      postJson(new URL('http://localhost:3010/x'), { payload: {} })
    ).rejects.toThrow('Not Found')
  })
})
