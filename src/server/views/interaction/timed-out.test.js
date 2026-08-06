jest.mock('~/src/server/lib/identity-api.js', () => ({
  requestOtp: jest.fn(),
  verifyOtp: jest.fn(),
  completeSignup: jest.fn(),
  getAccount: jest.fn(),
  getOtpEmail: jest.fn()
}))

/**
 * Boots a server whose interactions expire after the given number of
 * seconds, with the interaction already dead so the timed-out page renders
 * @param {string} ttlSeconds
 */
async function renderTimedOutPage(ttlSeconds) {
  const previous = process.env.OIDC_TTL_INTERACTION
  process.env.OIDC_TTL_INTERACTION = ttlSeconds
  jest.resetModules()

  try {
    const { createServer } = await import('~/src/server/index.js')
    const { errors } = await import('oidc-provider')

    const server = await createServer()
    await server.initialize()
    jest
      .spyOn(server.app.oidcProvider, 'interactionDetails')
      .mockRejectedValue(new errors.SessionNotFound('session not found'))

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/interaction/uid-1'
      })
      return response.payload
    } finally {
      await server.stop()
    }
  } finally {
    process.env.OIDC_TTL_INTERACTION = previous
    jest.resetModules()
  }
}

describe('timed-out page', () => {
  // the page is the only place a user is told how long they had, so the
  // number has to come from the same setting that actually cut them off
  it('quotes a half-hour interaction lifetime', async () => {
    const html = await renderTimedOutPage('1800')

    expect(html).toContain('You have 30 minutes to finish signing in.')
  })

  it('quotes an hour-long interaction lifetime', async () => {
    const html = await renderTimedOutPage('3600')

    expect(html).toContain('You have 1 hour to finish signing in.')
  })
})
