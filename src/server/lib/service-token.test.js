import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { Engine as CatboxMemory } from '@hapi/catbox-memory'
import Hapi from '@hapi/hapi'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
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
          // A six-hour STS session, so the configured duration applies. A test
          // can set an earlier expiry. Each call calculates the expiry again,
          // so the expiry follows the fake clock in the lifetime tests.
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

    it('uses the held credentials without a new read when they cover the configured token', async () => {
      const server = await buildServer()
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

      await getServiceToken()

      expect(credentialsOf()).toHaveBeenCalledTimes(1)
      expect(credentialsOf()).not.toHaveBeenCalledWith({ forceRefresh: true })
      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          DurationSeconds: config.get('identityApi.tokenDurationSeconds')
        })
      )
      await server.stop()
    })

    it('reads the credentials again, before the token request, when the held session is too short', async () => {
      const server = await buildServer()
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf()
        .mockResolvedValueOnce({ expiration: new Date(Date.now() + 240_000) })
        .mockResolvedValueOnce({
          expiration: new Date(Date.now() + SIX_HOURS_MS)
        })

      await getServiceToken()

      expect(credentialsOf()).toHaveBeenLastCalledWith({ forceRefresh: true })
      expect(credentialsOf().mock.invocationCallOrder[1]).toBeLessThan(
        sendOf().mock.invocationCallOrder[0]
      )
      // The new session lasts six hours, so the configured duration applies.
      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          DurationSeconds: config.get('identityApi.tokenDurationSeconds')
        })
      )
      await server.stop()
    })

    it('caps the requested lifetime to the STS session, less the buffer', async () => {
      const server = await buildServer()
      const info = jest.spyOn(logger, 'info').mockReturnValue(undefined)
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf().mockResolvedValue({
        expiration: new Date(Date.now() + 120_000)
      })

      await getServiceToken()

      expect(credentialsOf()).toHaveBeenCalledWith({ forceRefresh: true })
      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({ DurationSeconds: 110 })
      )
      expect(info).toHaveBeenCalledWith(
        '[serviceTokenDuration] Requesting a 110s token because the STS session ends in 120s'
      )
      await server.stop()
    })

    it('uses the held credentials when the new read fails', async () => {
      const server = await buildServer()
      const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)
      const readError = new Error('credentials endpoint unavailable')
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf()
        .mockResolvedValueOnce({ expiration: new Date(Date.now() + 120_000) })
        .mockRejectedValueOnce(readError)

      await expect(getServiceToken()).resolves.toBe('token-1')

      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({ DurationSeconds: 110 })
      )
      expect(warn).toHaveBeenCalledWith(
        readError,
        '[serviceTokenCredentials] Could not read new STS credentials, so the token request uses the current session, which ends in 120s'
      )
      await server.stop()
    })

    it('requests the STS minimum when the session has less time left than the minimum plus the buffer', async () => {
      const server = await buildServer()
      const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf().mockResolvedValue({
        expiration: new Date(Date.now() + 65_000)
      })

      await getServiceToken()

      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({ DurationSeconds: 60 })
      )
      // A 60-second token still expires before a 65-second session.
      expect(warn).not.toHaveBeenCalled()
      await server.stop()
    })

    it('warns when the session has less time left than the STS minimum', async () => {
      const server = await buildServer()
      const warn = jest.spyOn(logger, 'warn').mockReturnValue(undefined)
      sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })
      credentialsOf().mockResolvedValue({
        expiration: new Date(Date.now() + 50_000)
      })

      await getServiceToken()

      expect(GetWebIdentityTokenCommand).toHaveBeenCalledWith(
        expect.objectContaining({ DurationSeconds: 60 })
      )
      expect(warn).toHaveBeenCalledWith(
        '[serviceTokenDuration] The STS session ends in 50s, which is less than the minimum token duration of 60s, so STS rejects the token request'
      )
      await server.stop()
    })

    it('logs a failed token request with the session time left, and passes the error on', async () => {
      const server = await buildServer()
      const error = jest.spyOn(logger, 'error').mockReturnValue(undefined)
      const stsError = new Error('SessionDurationEscalationException')
      sendOf().mockRejectedValue(stsError)
      credentialsOf().mockResolvedValue({
        expiration: new Date(Date.now() + 120_000)
      })

      await expect(getServiceToken()).rejects.toThrow(stsError)

      expect(error).toHaveBeenCalledWith(
        stsError,
        '[serviceTokenRequest] STS did not issue a 110s token signed by a session that ends in 120s'
      )
      await server.stop()
    })

    it('logs a failed token request for credentials with no expiry', async () => {
      const server = await buildServer()
      const error = jest.spyOn(logger, 'error').mockReturnValue(undefined)
      const stsError = new Error('AccessDenied')
      sendOf().mockRejectedValue(stsError)
      credentialsOf().mockResolvedValue({})

      await expect(getServiceToken()).rejects.toThrow(stsError)

      expect(error).toHaveBeenCalledWith(
        stsError,
        `[serviceTokenRequest] STS did not issue a ${config.get('identityApi.tokenDurationSeconds')}s token signed by credentials with no expiry`
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
      // A session with two minutes left gives a 110-second token. The cache
      // removes it one minute early, so it keeps the token for 50 seconds.
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
