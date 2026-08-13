import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { getAccount } from '~/src/server/lib/identity-api.js'
import { context } from '~/src/server/plugins/nunjucks/context.js'
import { view } from '~/src/server/plugins/nunjucks/render.js'

// All required at startup — config validation refuses to boot without them
const JWKS = /** @type {{ keys: JWK[] }} */ (
  JSON.parse(config.get('oidc.jwks'))
)
const COOKIE_KEYS = config.get('oidc.cookieKeys').split(',')
const COOKIE_SECURE = config.get('oidc.cookieSecure')
const RUNNER_JWKS = /** @type {{ keys: JWK[] }} */ (
  JSON.parse(config.get('oidc.runnerJwks'))
)
const RUNNER_REDIRECT_URIS = config.get('oidc.runnerRedirectUris').split(',')
const TTL_SECONDS = {
  AuthorizationCode: config.get('oidc.ttl.authorizationCode'),
  IdToken: config.get('oidc.ttl.idToken'),
  AccessToken: config.get('oidc.ttl.accessToken'),
  Interaction: config.get('oidc.ttl.interaction'),
  Session: config.get('oidc.ttl.session'),
  Grant: config.get('oidc.ttl.grant')
}

/**
 * Builds the oidc-provider configuration
 * @param {AdapterConstructor} adapter
 * @returns {Configuration}
 */
export function buildProviderConfig(adapter) {
  return {
    adapter,
    clients: [
      {
        client_id: 'runner',
        redirect_uris: RUNNER_REDIRECT_URIS,
        response_types: ['code'],
        grant_types: ['authorization_code'],
        // The client proves itself by signing a short-lived assertion with a
        // private key we never hold — only its public half, below. Nothing
        // this service stores can impersonate the client, and there is no
        // shared secret to distribute or rotate in step.
        token_endpoint_auth_method: 'private_key_jwt',
        id_token_signed_response_alg: 'ES256',
        jwks: RUNNER_JWKS
      }
    ],
    jwks: { keys: JWKS.keys },
    clientAuthMethods: ['private_key_jwt'],
    pkce: { required: () => true },
    features: { devInteractions: { enabled: false } },
    interactions: {
      url(_ctx, interaction) {
        return `/interaction/${interaction.uid}`
      }
    },
    ttl: TTL_SECONDS,
    claims: { openid: ['sub'], email: ['email'] },
    async findAccount(_ctx, id) {
      const account = await getAccount(id)

      if (!account) {
        return undefined
      }

      return {
        accountId: account.id,
        claims() {
          return Promise.resolve({
            sub: account.id,
            email: account.email
          })
        }
      }
    },
    cookies: {
      keys: COOKIE_KEYS,
      long: { secure: COOKIE_SECURE, sameSite: 'lax' },
      short: { secure: COOKIE_SECURE, sameSite: 'lax' }
    },
    renderError(ctx, _out, error) {
      // Provider errors (persistence down, malformed protocol requests…)
      // render the standard 500 page instead of oidc-provider's unstyled
      // default, matching the error-pages plugin
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
 * @import { AdapterConstructor, Configuration, JWK } from 'oidc-provider'
 */
