import { createLogContext, runWithLogContext } from '@defra/forms-common'
import Wreck from '@hapi/wreck'

import {
  getJson,
  isNotFoundError,
  postJson
} from '~/src/server/common/helpers/fetch.js'

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
    expect(Wreck.request).toHaveBeenCalledWith(
      'get',
      'http://localhost:3010/x',
      { json: true }
    )
  })

  it('sends the correlation ID and user ID of the log context', async () => {
    jest
      .mocked(Wreck.request)
      .mockResolvedValue(/** @type {never} */ ({ statusCode: 200 }))
    jest.mocked(Wreck.read).mockResolvedValue(/** @type {never} */ ({}))

    await runWithLogContext(
      createLogContext({ correlationId: 'correlation-1', userId: 'acc-1' }),
      () =>
        getJson(new URL('http://localhost:3010/x'), {
          headers: { Authorization: 'Bearer token-1' }
        })
    )

    expect(Wreck.request).toHaveBeenCalledWith(
      'get',
      'http://localhost:3010/x',
      {
        json: true,
        headers: {
          Authorization: 'Bearer token-1',
          'x-cdp-request-id': 'correlation-1',
          'x-forms-user-id': 'acc-1'
        }
      }
    )
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

  it('still throws a recognisable Boom 404 when the body is empty', async () => {
    // Wreck parses a zero-length body to null, which the error branch must
    // not treat as an object — the 404 has to stay recognisable downstream
    jest
      .mocked(Wreck.request)
      .mockResolvedValue(/** @type {never} */ ({ statusCode: 404 }))
    jest.mocked(Wreck.read).mockResolvedValue(/** @type {never} */ (null))

    const err = await getJson(new URL('http://localhost:3010/x')).catch(
      (/** @type {unknown} */ e) => e
    )

    expect(isNotFoundError(err)).toBe(true)
  })

  it('still throws a recognisable Boom 404 when the body is a JSON primitive', async () => {
    jest
      .mocked(Wreck.request)
      .mockResolvedValue(/** @type {never} */ ({ statusCode: 404 }))
    jest.mocked(Wreck.read).mockResolvedValue(/** @type {never} */ ('gone'))

    const err = await getJson(new URL('http://localhost:3010/x')).catch(
      (/** @type {unknown} */ e) => e
    )

    expect(isNotFoundError(err)).toBe(true)
  })
})
