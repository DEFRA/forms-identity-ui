import { config } from '~/src/config/index.js'

const redirectUris = config.get('oidc.runnerRedirectUris')

/**
 * @param {string} value
 * @returns {URL | null}
 */
function parseUri(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

/**
 * The path must be within the runner service to prevent rogue URLs fooling users into nevigating 'Back' to a rogue site.
 * @param {string} [value]
 * @returns {string | null}
 */
export function runnerHomepageReturnPath(value) {
  if (typeof value !== 'string') {
    return null
  }

  const url = parseUri(value)
  if (!url) {
    return null
  }

  // Use OIDC_RUNNER_REDIRECT_URIS as the list of allowable hosts that a 'Back' navigation can go to
  const uniqueHosts = new Set()
  redirectUris.forEach((uri) => {
    const redirectUri = parseUri(uri)
    if (redirectUri) {
      uniqueHosts.add(`${redirectUri.protocol}://${redirectUri.host}`)
    }
  })

  if (!uniqueHosts.has(`${url.protocol}://${url.host}`)) {
    return null
  }

  // The path must be within a 'hompegae' route
  return url.pathname.startsWith('/homepage/') ? url.href : null
}
