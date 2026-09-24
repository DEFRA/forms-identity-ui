import { errors } from 'oidc-provider'

import { config } from '~/src/config/index.js'
import { logger } from '~/src/server/common/helpers/logging/logger.js'
import { SIGNING_ALG } from '~/src/server/constants.js'
import { getAccount } from '~/src/server/lib/identity-api.js'
import { getServiceToken } from '~/src/server/lib/service-token.js'
import { context } from '~/src/server/plugins/nunjucks/context.js'
import { view } from '~/src/server/plugins/nunjucks/render.js'

// All required at startup — config validation refuses to boot without them
const JWKS = /** @type {{ keys: JWK[] }} */ (
  JSON.parse(config.get('oidc.jwks'))
)
const COOKIE_KEYS = config.get('oidc.cookieKeys')
const COOKIE_SECURE = config.get('oidc.cookieSecure')
const RUNNER_JWKS = /** @type {{ keys: JWK[] }} */ (
  JSON.parse(config.get('oidc.runnerJwks'))
)
const RUNNER_REDIRECT_URIS = config.get('oidc.runnerRedirectUris')
const RUNNER_POST_LOGOUT_REDIRECT_URIS = config.get(
  'oidc.runnerPostLogoutRedirectUris'
)

/**
 * The APIs this provider issues access tokens for.
 */
const RESOURCE_SERVERS = new Set(config.get('oidc.resourceServers'))

const REFRESH_TOKEN_TTL = /** @type number */ config.get(
  'oidc.ttl.refreshToken'
)

const TTL_SECONDS = {
  AuthorizationCode: config.get('oidc.ttl.authorizationCode'),
  IdToken: config.get('oidc.ttl.idToken'),
  AccessToken: config.get('oidc.ttl.accessToken'),
  /**
   * A rotated refresh token keeps the time left on the one it replaces, so
   * refreshing cannot extend a sign-in beyond the lifetime set here.
   * @param {KoaContextWithOIDC | undefined} ctx - undefined when a token is
   * read outside a request
   * @returns {number}
   */
  RefreshToken(ctx) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the library's own default guards `oidc` too, as its typings do not cover every caller
    const rotated = ctx?.oidc?.entities.RotatedRefreshToken

    return rotated ? rotated.remainingTTL : REFRESH_TOKEN_TTL
  },
  Interaction: config.get('oidc.ttl.interaction'),
  Session: config.get('oidc.ttl.session'),
  Grant: config.get('oidc.ttl.grant')
}

/**
 * The URI for the Cancel link on the sign-out page. It is the client's
 * post-logout redirect URI, with the client's `state` and `cancelled=true`.
 * The provider has already checked this URI against the client's registered
 * URIs. This makes sure that the link only goes back to the client that sent
 * the user. The client uses `cancelled=true` to know that the user did not
 * sign out.
 * @param {KoaContextWithOIDC} ctx
 * @returns {string | undefined}
 */
function cancelUriFor(ctx) {
  const { post_logout_redirect_uri: postLogoutRedirectUri, state } =
    ctx.oidc.params ?? {}

  if (typeof postLogoutRedirectUri !== 'string') {
    return undefined
  }

  const cancelUri = new URL(postLogoutRedirectUri)

  if (typeof state === 'string') {
    cancelUri.searchParams.set('state', state)
  }
  cancelUri.searchParams.set('cancelled', 'true')

  return cancelUri.href
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
        post_logout_redirect_uris: RUNNER_POST_LOGOUT_REDIRECT_URIS,
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
        // The client proves itself by signing a short-lived assertion with a
        // private key we never hold — only its public half, below. Nothing
        // this service stores can impersonate the client, and there is no
        // shared secret to distribute or rotate in step.
        token_endpoint_auth_method: 'private_key_jwt',
        id_token_signed_response_alg: SIGNING_ALG,
        jwks: RUNNER_JWKS
      }
    ],
    jwks: { keys: JWKS.keys },
    clientAuthMethods: ['private_key_jwt'],
    pkce: { required: () => true },
    // The library only issues a refresh token when `offline_access` was
    // requested, which also forces a consent prompt. Tokens are only used
    // while the citizen is using the service, so that scope does not apply:
    // any client allowed the grant gets one.
    issueRefreshToken(_ctx, client) {
      return client.grantTypeAllowed('refresh_token')
    },
    // Every refresh returns a new refresh token and consumes the old one. A
    // consumed token used again makes the provider revoke the whole grant.
    // `expiresWithSession` is left at its default, so without
    // `offline_access` a refresh token stops working when the provider
    // session ends (for example, sign-out in another tab).
    rotateRefreshToken: true,
    // Discovery is a promise to every relying party, so it states what this
    // deployment does and nothing more: one client, the authorization code
    // flow, one scope beyond the claims below, and RS256 for the tokens
    // signed here and for the assertions a client signs
    responseTypes: ['code'],
    scopes: ['openid'],
    enabledJWA: {
      idTokenSigningAlgValues: [SIGNING_ALG],
      clientAuthSigningAlgValues: [SIGNING_ALG]
    },
    features: {
      rpInitiatedLogout: {
        enabled: true,
        // The page shows the provider's own sign-out form. The provider's
        // confirm step then does the full sign-out. It checks the xsrf value,
        // revokes the grants, clears the cookie and redirects to the client.
        // When the ID token hint identifies the signed-in user, the page
        // presses its Sign out button on load. Without JavaScript, the user
        // presses the button.
        logoutSource(ctx, form) {
          const accountId = ctx.oidc.session?.accountId

          ctx.type = 'html'
          ctx.body = view('signout.html', {
            context: {
              ...context(null),
              form,
              cancelUri: cancelUriFor(ctx),
              autoSubmit:
                accountId !== undefined &&
                ctx.oidc.entities.IdTokenHint?.payload.sub === accountId
            }
          })
          return Promise.resolve()
        }
      },
      devInteractions: { enabled: false },
      // On by default, and its endpoint is deliberately not mounted
      pushedAuthorizationRequests: { enabled: false },
      resourceIndicators: {
        enabled: true,
        useGrantedResource: () => true,
        getResourceServerInfo(_ctx, resourceIndicator) {
          if (!RESOURCE_SERVERS.has(resourceIndicator)) {
            throw new errors.InvalidTarget()
          }

          return {
            // Data is filtered on the APIs by `sub`, so scopes aren't
            // required for now
            scope: '',
            audience: resourceIndicator,
            accessTokenFormat: 'jwt',
            accessTokenTTL: TTL_SECONDS.AccessToken,
            jwt: { sign: { alg: SIGNING_ALG } }
          }
        }
      }
    },
    interactions: {
      url(_ctx, interaction) {
        return `/interaction/${interaction.uid}`
      }
    },
    ttl: TTL_SECONDS,
    claims: { openid: ['sub'], email: ['email'] },
    async findAccount(_ctx, id) {
      const account = await getAccount(id, await getServiceToken())

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
 * @import { AdapterConstructor, Configuration, JWK, KoaContextWithOIDC } from 'oidc-provider'
 */
