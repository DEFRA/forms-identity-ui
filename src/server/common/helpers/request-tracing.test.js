import {
  USER_ID_HEADER,
  createLogContext,
  getCorrelationId,
  getUserId,
  runWithLogContext,
  setUserId
} from '@defra/forms-common'
import { getTraceId } from '@defra/hapi-tracing'
import hapi from '@hapi/hapi'

import {
  applyLogContextHeaders,
  requestTracing
} from '~/src/server/common/helpers/request-tracing.js'

describe('request-tracing', () => {
  const tracingHeader = 'x-cdp-request-id'
  const correlationId = '1066e8cc-8e1e-4671-8ad7-b4cd9c95bb94'
  const userId = '86758ba9-92e7-4287-9751-7705e449f0a5'

  describe('plugin', () => {
    /** @type {Server} */
    let server

    /** @type {{ correlationId?: string, userId?: string }} */
    let responseContext

    beforeEach(async () => {
      server = hapi.server()
      responseContext = {}

      await server.register(requestTracing)

      const handler = () => ({
        correlationId: getCorrelationId(),
        traceId: getTraceId(),
        userId: getUserId()
      })

      server.route([
        { method: 'GET', path: '/open', handler },
        {
          method: 'GET',
          path: '/sign-in',
          handler() {
            setUserId(userId)

            return handler()
          }
        }
      ])

      // The response log is written when this event is emitted
      server.events.on('response', () => {
        responseContext = {
          correlationId: getCorrelationId(),
          userId: getUserId()
        }
      })
    })

    afterEach(async () => {
      await server.stop()
    })

    it('should use the correlation ID from the tracing header', async () => {
      const { result } = await server.inject({
        method: 'GET',
        url: '/open',
        headers: { [tracingHeader]: correlationId }
      })

      expect(result).toEqual({
        correlationId,
        traceId: correlationId,
        userId: undefined
      })
      expect(responseContext).toEqual({ correlationId, userId: undefined })
    })

    it('should keep the user ID set while the request is handled', async () => {
      const { result } = await server.inject({
        method: 'GET',
        url: '/sign-in',
        headers: { [tracingHeader]: correlationId }
      })

      expect(result).toEqual({
        correlationId,
        traceId: correlationId,
        userId
      })
      expect(responseContext).toEqual({ correlationId, userId })
    })
  })

  describe('applyLogContextHeaders', () => {
    const headers = { Authorization: 'Bearer token' }

    it('should return the headers unchanged outside of a log context', () => {
      expect(applyLogContextHeaders(headers)).toBe(headers)
      expect(applyLogContextHeaders()).toBeUndefined()
    })

    it('should add the correlation ID', () => {
      runWithLogContext(createLogContext({ correlationId }), () => {
        expect(applyLogContextHeaders(headers)).toEqual({
          ...headers,
          [tracingHeader]: correlationId
        })
        expect(applyLogContextHeaders()).toEqual({
          [tracingHeader]: correlationId
        })
      })
    })

    it('should add the user ID when there is one', () => {
      runWithLogContext(createLogContext({ correlationId, userId }), () => {
        expect(applyLogContextHeaders(headers)).toEqual({
          ...headers,
          [tracingHeader]: correlationId,
          [USER_ID_HEADER]: userId
        })
      })
    })
  })
})

/**
 * @import { Server } from '@hapi/hapi'
 */
