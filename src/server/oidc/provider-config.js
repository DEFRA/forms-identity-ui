import { getJson } from '~/src/server/common/helpers/fetch.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { context } from '~/src/server/plugins/nunjucks/context.js'
import { view } from '~/src/server/plugins/nunjucks/render.js'

/**
 * Build the oidc-provider configuration from convict config. All secrets are
 * REQUIRED with no boot-generate fallback: boot-generated keys break
 * horizontal scaling and silently mask a missing secret in a deployed env.
 * Local dev and tests supply them via .env / the jest setup file.
 * @param {typeof appConfig} config
 * @param {AdapterConstructor} adapter
 * @returns {Configuration}
 */
export function buildProviderConfig(config, adapter) {
  const jwksRaw = config.get('oidc.jwks')

  if (!jwksRaw) {
    throw new Error(
      'OIDC_JWKS must be set (run `node scripts/generate-jwks.mjs` and put it in .env)'
    )
  }

  const cookieKeysRaw = config.get('oidc.cookieKeys')

  if (!cookieKeysRaw) {
    throw new Error(
      'OIDC_COOKIE_KEYS must be set (comma-separated, identical across containers)'
    )
  }

  const clientSecret = config.get('oidc.clientSecret')

  if (!clientSecret) {
    throw new Error('OIDC_CLIENT_SECRET must be set (confidential client auth)')
  }

  const jwks = /** @type {{ keys: JWK[] }} */ (JSON.parse(jwksRaw))
  const cookieSecure = config.get('oidc.cookieSecure')
  const apiBaseUrl = config.get('identityApi.url')

  return {
    adapter,
    clients: [
      {
        client_id: 'runner',
        client_secret: clientSecret,
        redirect_uris: config.get('oidc.runnerRedirectUris').split(','),
        response_types: ['code'],
        grant_types: ['authorization_code'],
        token_endpoint_auth_method: 'client_secret_basic'
      }
    ],
    jwks: { keys: jwks.keys },
    clientAuthMethods: ['client_secret_basic'],
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false } },
    interactions: {
      url(_ctx, interaction) {
        return `/interaction/${interaction.uid}`
      }
    },
    ttl: {
      AuthorizationCode: 60,
      IdToken: 300,
      AccessToken: 300,
      Interaction: 3600,
      Session: 86400,
      Grant: 86400
    },
    claims: { openid: ['sub'], email: ['email', 'email_verified'] },
    async findAccount(_ctx, id) {
      /** @type {{ id: string, email: string }} */
      let account

      try {
        const { body } = await getJson(new URL(`/accounts/${id}`, apiBaseUrl))
        account = /** @type {{ id: string, email: string }} */ (body)
      } catch (err) {
        if (
          err instanceof Error &&
          'isBoom' in err &&
          'output' in err &&
          /** @type {{ output: { statusCode: number } }} */ (err).output
            .statusCode === 404
        ) {
          return undefined
        }
        throw err
      }

      return {
        accountId: account.id,
        claims() {
          return Promise.resolve({
            sub: account.id,
            email: account.email,
            email_verified: true
          })
        }
      }
    },
    cookies: {
      keys: cookieKeysRaw.split(','),
      long: { secure: cookieSecure, sameSite: 'lax' },
      short: { secure: cookieSecure, sameSite: 'lax' }
    },
    renderError(ctx, _out, error) {
      // Provider errors (persistence down, malformed protocol requests…)
      // render the standard 500 page instead of oidc-provider's unstyled
      // default, matching the error-pages plugin convention
      logger.error(
        error,
        `[oidcError] provider error rendered - path: ${ctx.path}`
      )
      ctx.type = 'html'
      ctx.body = view('500.html', { context: context(null) })
    }
  }
}

/**
 * @import { config as appConfig } from '~/src/config/index.js'
 * @import { AdapterConstructor, Configuration, JWK } from 'oidc-provider'
 */
