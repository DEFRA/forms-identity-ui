import http from 'node:http'

import { Engine as CatboxMemory } from '@hapi/catbox-memory'
import Hapi from '@hapi/hapi'

/**
 * These tests use the real STSClient and the default AWS credential chain, so
 * they cover the SDK behaviour that the unit tests replace with a stub. Two
 * local HTTP servers stand in for AWS:
 *  - a container credentials endpoint, as ECS serves to the task
 *  - an STS endpoint that rejects a token which outlives the STS session that
 *    signs the request, as STS does with SessionDurationEscalationException
 * Date.now is moved forward to reach the end of a six-hour session.
 */

const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

const ENV_KEYS = [
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_ENDPOINT_URL_STS',
  'AWS_REGION',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy'
]

const realNow = Date.now.bind(Date)
const startMs = realNow()
let offsetMs = 0
const now = () => startMs + offsetMs

/**
 * @typedef {object} Session
 * @property {string} id - the access key ID, which identifies the session
 * @property {number} expiresAt - the session expiry in milliseconds
 */

/**
 * Chooses the session that the credentials endpoint serves at the current
 * time. It throws to make the endpoint return HTTP 500.
 * @type {() => Session}
 */
let serveSession

/** @type {Map<string, number>} session ID to session expiry */
const sessionExpiries = new Map()

/** @type {string[]} */
let credentialReads = []

const originalEnv = process.env

/** @type {http.Server} */
let credentialsServer

/** @type {http.Server} */
let stsServer

/**
 * @param {http.RequestListener} handler
 * @returns {Promise<http.Server>}
 */
function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/**
 * @param {http.Server} server
 * @returns {string}
 */
function urlOf(server) {
  const address = /** @type {import('node:net').AddressInfo} */ (
    server.address()
  )
  return `http://127.0.0.1:${address.port}`
}

/** @type {http.RequestListener} */
function credentialsEndpoint(_req, res) {
  /** @type {Session} */
  let session
  try {
    session = serveSession()
  } catch {
    credentialReads.push('unavailable')
    res.statusCode = 500
    res.end('{}')
    return
  }

  credentialReads.push(session.id)
  sessionExpiries.set(session.id, session.expiresAt)
  res.setHeader('content-type', 'application/json')
  res.end(
    JSON.stringify({
      AccessKeyId: session.id,
      SecretAccessKey: 'secret',
      Token: 'session-token',
      Expiration: new Date(session.expiresAt).toISOString()
    })
  )
}

/** @type {http.RequestListener} */
function stsEndpoint(req, res) {
  let body = ''
  req.on('data', (chunk) => {
    body += String(chunk)
  })
  req.on('end', () => {
    const durationSeconds = Number(
      new URLSearchParams(body).get('DurationSeconds')
    )
    const sessionId =
      /Credential=([^/]+)\//.exec(req.headers.authorization ?? '')?.[1] ?? ''
    const sessionExpiry = sessionExpiries.get(sessionId) ?? 0

    res.setHeader('content-type', 'text/xml')
    // The fake clock is ahead of the real one. The Date header follows the
    // fake clock, so the SDK sees no clock skew and does not retry.
    res.setHeader('date', new Date(now()).toUTCString())

    if (now() + durationSeconds * 1000 > sessionExpiry) {
      res.statusCode = 400
      res.end(
        '<ErrorResponse><Error><Type>Sender</Type><Code>SessionDurationEscalationException</Code><Message>The requested token duration would extend the session beyond its original expiration time.</Message></Error><RequestId>r</RequestId></ErrorResponse>'
      )
      return
    }

    res.end(
      `<GetWebIdentityTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetWebIdentityTokenResult><WebIdentityToken>${sessionId}:${durationSeconds}s</WebIdentityToken><Expiration>${new Date(now() + durationSeconds * 1000).toISOString()}</Expiration></GetWebIdentityTokenResult><ResponseMetadata><RequestId>r</RequestId></ResponseMetadata></GetWebIdentityTokenResponse>`
    )
  })
}

/**
 * Starts a server with the plugin. The module is imported for each test, and
 * Jest resets the module registry between tests, so each test gets a new SDK
 * client with no credentials in memory.
 */
async function start() {
  const { serviceToken, getServiceToken } =
    await import('~/src/server/lib/service-token.js')
  const { logger } =
    await import('~/src/server/common/helpers/logging/logger.js')
  const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)
  jest.spyOn(logger, 'info').mockReturnValue(undefined)
  jest.spyOn(logger, 'error').mockReturnValue(undefined)

  const server = Hapi.server({
    cache: [{ name: 'service-token', engine: new CatboxMemory() }]
  })
  await server.register(serviceToken)
  await server.initialize()

  return { server, getServiceToken, warn }
}

describe('service-token with the AWS SDK', () => {
  beforeAll(async () => {
    credentialsServer = await listen(credentialsEndpoint)
    stsServer = await listen(stsEndpoint)

    // A copy without the developer's own AWS and proxy settings
    process.env = Object.fromEntries(
      Object.entries(originalEnv).filter(([key]) => !ENV_KEYS.includes(key))
    )
    process.env.AWS_REGION = 'eu-west-2'
    process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/credentials'
    process.env.AWS_CONFIG_FILE = '/nonexistent/config'
    process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI = `${urlOf(credentialsServer)}/credentials`
    process.env.AWS_ENDPOINT_URL_STS = urlOf(stsServer)
  })

  afterAll(async () => {
    process.env = originalEnv

    credentialsServer.closeAllConnections()
    stsServer.closeAllConnections()
    await Promise.all([
      new Promise((resolve) => credentialsServer.close(resolve)),
      new Promise((resolve) => stsServer.close(resolve))
    ])
  })

  beforeEach(() => {
    offsetMs = 0
    credentialReads = []
    sessionExpiries.clear()
    jest.spyOn(Date, 'now').mockImplementation(now)
  })

  it('uses the new session when the endpoint serves it within five minutes of the old expiry', async () => {
    // The endpoint serves session B from 30 minutes before session A expires.
    // In the last five minutes of session A, the SDK returns A from memory
    // and reads B only in the background. Without a new read, the token
    // request is signed by A.
    serveSession = () =>
      now() < startMs + 6 * HOUR_MS - 30 * MINUTE_MS
        ? { id: 'SESSION_A', expiresAt: startMs + 6 * HOUR_MS }
        : { id: 'SESSION_B', expiresAt: startMs + 12 * HOUR_MS }
    const { server, getServiceToken } = await start()

    await expect(getServiceToken()).resolves.toBe('SESSION_A:300s')

    offsetMs = 6 * HOUR_MS - 4 * MINUTE_MS
    await expect(getServiceToken()).resolves.toBe('SESSION_B:300s')
    await server.stop()
  })

  it('does not read the credentials endpoint while the held session covers the token', async () => {
    serveSession = () => {
      if (now() >= startMs + HOUR_MS) {
        throw new Error('credentials endpoint unavailable')
      }
      return { id: 'SESSION_A', expiresAt: startMs + 6 * HOUR_MS }
    }
    const { server, getServiceToken } = await start()

    await expect(getServiceToken()).resolves.toBe('SESSION_A:300s')

    // One hour on, the cached token has expired and the endpoint fails.
    offsetMs = HOUR_MS
    await expect(getServiceToken()).resolves.toBe('SESSION_A:300s')
    expect(credentialReads).toEqual(['SESSION_A'])
    await server.stop()
  })

  it('caps the token to the session when the endpoint still serves the old session', async () => {
    serveSession = () =>
      now() < startMs + 6 * HOUR_MS
        ? { id: 'SESSION_A', expiresAt: startMs + 6 * HOUR_MS }
        : { id: 'SESSION_B', expiresAt: startMs + 12 * HOUR_MS }
    const { server, getServiceToken } = await start()

    await getServiceToken()

    offsetMs = 6 * HOUR_MS - 4 * MINUTE_MS
    await expect(getServiceToken()).resolves.toBe('SESSION_A:230s')
    await server.stop()
  })

  // This is a known limit, not wanted behaviour: STS issues no token shorter
  // than 60 seconds, so no request is valid in the last minute of a session.
  it('fails with a warning when the endpoint serves a session with less than a minute left', async () => {
    serveSession = () =>
      now() < startMs + 6 * HOUR_MS
        ? { id: 'SESSION_A', expiresAt: startMs + 6 * HOUR_MS }
        : { id: 'SESSION_B', expiresAt: startMs + 12 * HOUR_MS }
    const { server, getServiceToken, warn } = await start()

    await getServiceToken()

    offsetMs = 6 * HOUR_MS - 50_000
    await expect(getServiceToken()).rejects.toThrow(
      'The requested token duration would extend the session beyond its original expiration time.'
    )
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('The STS session ends in 50s')
    )
    await server.stop()
  })
})
