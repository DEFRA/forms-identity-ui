import {
  REFERENCE_NUMBER_HEADER,
  SESSION_ID_HEADER,
  USER_ID_HEADER,
  createLogContext,
  getCorrelationId,
  getReferenceNumber,
  getSessionId,
  getUserId,
  runWithLogContext,
  setUserId
} from '@defra/forms-common'
import { getTraceId } from '@defra/hapi-tracing'
import hapi from '@hapi/hapi'
import yar from '@hapi/yar'

import {
  applyLogContextHeaders,
  applyTraceHeaders,
  getRequestSessionId,
  requestTracing
} from '~/src/server/common/helpers/request-tracing.js'

describe('request-tracing', () => {
  const tracingHeader = 'x-cdp-request-id'
  const correlationId = '1066e8cc-8e1e-4671-8ad7-b4cd9c95bb94'
  const userId = '86758ba9-92e7-4287-9751-7705e449f0a5'
  const sessionId = 'c3a2e5f4-2b8e-4e1f-9a8d-3f6b7c1d2e9a'
  const identityApiUrl = new URL('http://localhost:3010/accounts')
  const externalUrl = new URL('https://example.com/endpoint')

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

    it('should not read the session ID or reference number headers sent by a browser', async () => {
      server.route({
        method: 'GET',
        path: '/log-context',
        handler: () => ({
          sessionId: getSessionId() ?? null,
          referenceNumber: getReferenceNumber() ?? null
        })
      })

      const { result } = await server.inject({
        method: 'GET',
        url: '/log-context',
        headers: {
          [SESSION_ID_HEADER]: sessionId,
          [REFERENCE_NUMBER_HEADER]: 'ABC-123-DEF'
        }
      })

      expect(result).toEqual({ sessionId: null, referenceNumber: null })
    })
  })

  describe('session ID', () => {
    it('should add the ID of the yar session', async () => {
      const server = hapi.server()

      await server.register(requestTracing)
      await server.register({
        plugin: yar,
        options: {
          storeBlank: true,
          cookieOptions: {
            password:
              'the-test-session-cookie-password-at-least-32-characters-long',
            isSecure: false
          }
        }
      })

      server.route({
        method: 'GET',
        path: '/session',
        handler: (request) => ({
          yarId: request.yar.id,
          sessionId: getSessionId()
        })
      })

      const { result } =
        /** @type {{ result: { yarId: string, sessionId?: string } }} */ (
          await server.inject({ method: 'GET', url: '/session' })
        )

      expect(result.sessionId).toBeDefined()
      expect(result.sessionId).toBe(result.yarId)

      await server.stop()
    })
  })

  describe('getRequestSessionId', () => {
    it('should return the ID of the yar session', () => {
      const request = /** @type {Request} */ (
        /** @type {unknown} */ ({ yar: { id: sessionId } })
      )

      expect(getRequestSessionId(request)).toBe(sessionId)
    })

    it('should return undefined when yar is not registered', () => {
      const request = /** @type {Request} */ (/** @type {unknown} */ ({}))

      expect(getRequestSessionId(request)).toBeUndefined()
    })
  })

  describe('applyTraceHeaders', () => {
    const headers = { Authorization: 'Bearer token' }

    it('should return the headers unchanged outside of a log context', () => {
      expect(applyTraceHeaders(headers)).toBe(headers)
      expect(applyTraceHeaders()).toBeUndefined()
    })

    it('should add the correlation ID', () => {
      runWithLogContext(createLogContext({ correlationId }), () => {
        expect(applyTraceHeaders(headers)).toEqual({
          ...headers,
          [tracingHeader]: correlationId
        })
        expect(applyTraceHeaders()).toEqual({
          [tracingHeader]: correlationId
        })
      })
    })
  })

  describe('applyLogContextHeaders', () => {
    const headers = { Authorization: 'Bearer token' }

    it('should return the headers unchanged outside of a log context', () => {
      expect(applyLogContextHeaders(identityApiUrl, headers)).toBe(headers)
      expect(applyLogContextHeaders(identityApiUrl)).toBeUndefined()
    })

    it('should add the user ID and session ID for forms-identity-api', () => {
      runWithLogContext(
        createLogContext({ correlationId, userId, sessionId }),
        () => {
          expect(applyLogContextHeaders(identityApiUrl, headers)).toEqual({
            ...headers,
            [USER_ID_HEADER]: userId,
            [SESSION_ID_HEADER]: sessionId
          })
        }
      )
    })

    it('should not add the user ID or session ID for a service outside forms', () => {
      runWithLogContext(
        createLogContext({ correlationId, userId, sessionId }),
        () => {
          expect(applyLogContextHeaders(externalUrl, headers)).toBe(headers)
        }
      )
    })
  })
})

/**
 * @import { Request, Server } from '@hapi/hapi'
 */
