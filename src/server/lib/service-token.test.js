import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { Engine as CatboxMemory } from '@hapi/catbox-memory'
import Hapi from '@hapi/hapi'

import { config } from '~/src/config/index.js'
import {
  getServiceToken,
  serviceAuthHeaders,
  serviceToken
} from '~/src/server/lib/service-token.js'

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

/** The single mocked client instance's send */
const sendOf = () => jest.mocked(STSClient).mock.results[0].value.send

/** The single mocked client instance's resolved credentials provider */
const credentialsOf = () =>
  jest.mocked(STSClient).mock.results[0].value.config.credentials

async function buildServer() {
  const server = Hapi.server({
    cache: [{ name: 'service-token', engine: new CatboxMemory() }]
  })
  await server.register(serviceToken)
  await server.initialize()
  return server
}

describe('service-token', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    // The repo-wide `resetMocks` config wipes a jest.fn() factory
    // implementation before every test, so the client shape is reinstated
    // here rather than relied on from the jest.mock() call above.
    jest.mocked(STSClient).mockImplementation(
      () =>
        /** @type {never} */ ({
          send: jest.fn(),
          destroy: jest.fn(),
          // A long-lived STS session, so the configured lifetime stands unless a
          // test gives the credentials a nearer expiry. The expiry is computed
          // per call, so it tracks the faked clock in the lifetime tests.
          config: {
            credentials: jest.fn(() =>
              Promise.resolve({
                expiration: new Date(Date.now() + SIX_HOURS_MS)
              })
            )
          }
        })
    )
  })

  it('asks STS for a token addressed to the identity API', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

    await getServiceToken()

    expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith({
      SigningAlgorithm: 'RS256',
      Audience: [config.get('identityApi.audience')],
      DurationSeconds: config.get('identityApi.tokenDurationSeconds')
    })
    await server.stop()
  })

  it('returns the token from STS', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

    await expect(getServiceToken()).resolves.toBe('token-1')
    await server.stop()
  })

  it('reuses a cached token rather than calling STS each time', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

    await getServiceToken()
    await getServiceToken()
    await getServiceToken()

    expect(sendOf()).toHaveBeenCalledTimes(1)
    await server.stop()
  })

  it('serviceAuthHeaders carries the current token as a bearer header', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

    await expect(serviceAuthHeaders()).resolves.toEqual({
      Authorization: 'Bearer token-1'
    })
    await server.stop()
  })

  it('fails loudly when STS returns no token', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({})

    await expect(getServiceToken()).rejects.toThrow(
      'STS returned no web identity token'
    )
    await server.stop()
  })

  describe('token duration', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('caps the requested lifetime to the STS session, less the buffer', async () => {
      const server = await buildServer()
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf().mockResolvedValue({
        expiration: new Date(Date.now() + 120_000)
      })

      await getServiceToken()

      expect(credentialsOf()).toHaveBeenCalledWith({ forceRefresh: true })
      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({ DurationSeconds: 110 })
      )
      await server.stop()
    })

    it('requests the configured lifetime when the session has no expiry', async () => {
      const server = await buildServer()
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf().mockResolvedValue({})

      await getServiceToken()

      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          DurationSeconds: config.get('identityApi.tokenDurationSeconds')
        })
      )
      await server.stop()
    })
  })

  describe('token lifetime', () => {
    beforeEach(() => {
      jest.useFakeTimers()
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('serves the same token throughout the four-minute cache lifetime', async () => {
      const server = await buildServer()
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

      await getServiceToken()
      jest.advanceTimersByTime(4 * 60_000 - 1000)

      await expect(getServiceToken()).resolves.toBe('token-1')
      expect(sendOf()).toHaveBeenCalledTimes(1)
      await server.stop()
    })

    it('refreshes inside the safety buffer, before the token itself expires', async () => {
      const server = await buildServer()
      sendOf()
        .mockResolvedValueOnce({ WebIdentityToken: 'token-1' })
        .mockResolvedValueOnce({ WebIdentityToken: 'token-2' })

      await getServiceToken()
      jest.advanceTimersByTime(4 * 60_000 + 30_000)

      await expect(getServiceToken()).resolves.toBe('token-2')
      expect(sendOf()).toHaveBeenCalledTimes(2)
      await server.stop()
    })

    it('never serves a token past its five-minute expiry', async () => {
      const server = await buildServer()
      sendOf()
        .mockResolvedValueOnce({ WebIdentityToken: 'token-1' })
        .mockResolvedValueOnce({ WebIdentityToken: 'token-2' })

      await getServiceToken()
      jest.advanceTimersByTime(5 * 60_000 + 1000)

      await expect(getServiceToken()).resolves.toBe('token-2')
      expect(sendOf()).toHaveBeenCalledTimes(2)
      await server.stop()
    })

    it('retires a capped token at its own shorter lifetime', async () => {
      const server = await buildServer()
      sendOf()
        .mockResolvedValueOnce({ WebIdentityToken: 'token-1' })
        .mockResolvedValueOnce({ WebIdentityToken: 'token-2' })
      // A session with two minutes left issues a 110-second token, retired a
      // minute early, so the cache holds it for fifty seconds.
      credentialsOf().mockResolvedValue({
        expiration: new Date(Date.now() + 120_000)
      })

      await getServiceToken()
      jest.advanceTimersByTime(50_000 + 1000)

      await expect(getServiceToken()).resolves.toBe('token-2')
      expect(sendOf()).toHaveBeenCalledTimes(2)
      await server.stop()
    })
  })
})
