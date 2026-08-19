import { GetWebIdentityTokenCommand, STSClient } from '@aws-sdk/client-sts'
import { Engine as CatboxMemory } from '@hapi/catbox-memory'
import Hapi from '@hapi/hapi'

import { config } from '~/src/config/index.js'
import {
  getServiceToken,
  serviceToken,
  tokenTtlMs
} from '~/src/server/lib/service-token.js'

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn(),
  GetWebIdentityTokenCommand: jest.fn((input) => ({ input }))
}))

/** The single mocked client instance's send */
const sendOf = () => jest.mocked(STSClient).mock.results[0].value.send

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
    jest
      .mocked(STSClient)
      .mockImplementation(
        () => /** @type {never} */ ({ send: jest.fn(), destroy: jest.fn() })
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

  it('returns the minted token', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

    await expect(getServiceToken()).resolves.toBe('token-1')
    await server.stop()
  })

  it('reuses a cached token rather than minting one per call', async () => {
    const server = await buildServer()
    sendOf().mockResolvedValue({ WebIdentityToken: 'token-1' })

    await getServiceToken()
    await getServiceToken()
    await getServiceToken()

    expect(sendOf()).toHaveBeenCalledTimes(1)
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
})

describe('tokenTtlMs', () => {
  it('takes the margined lifetime from Expiration when STS clamps it short', () => {
    const requestedSeconds = 300
    const expiration = new Date(Date.now() + 60_000)

    const ttl = tokenTtlMs(expiration, requestedSeconds)

    // 60s margined at 0.8 is well under the unclamped 300s * 0.8
    expect(ttl).toBeLessThan(requestedSeconds * 1000 * 0.8)
    expect(ttl).toBeGreaterThan(0)
  })

  it('falls back to the margined requested duration with no Expiration', () => {
    expect(tokenTtlMs(undefined, 300)).toBe(300 * 1000 * 0.8)
  })

  it('falls back to the margined requested duration when Expiration has already passed', () => {
    const requestedSeconds = 300

    expect(tokenTtlMs(new Date(Date.now() - 1000), requestedSeconds)).toBe(
      requestedSeconds * 1000 * 0.8
    )
  })
})
