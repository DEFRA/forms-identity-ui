/**
 * Minimal HTML rendering for the example RP — kept apart from the OIDC
 * wiring in index.mjs so each file does one thing.
 */

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
}

/** @param {string} body */
export function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example RP</title></head><body><h1>Example RP</h1>${body}</body></html>`
}

/**
 * A labelled table of name/value pairs. Rendered as a real table with a
 * caption so each value can be found by its name, both by a screen reader
 * and by the e2e tests.
 * @param {string} caption
 * @param {object} values
 */
function table(caption, values) {
  const rows = Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(
      ([name, value]) =>
        `<tr><th scope="row">${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`
    )
    .join('')

  return `<table><caption>${escapeHtml(caption)}</caption><tbody>${rows}</tbody></table>`
}

/**
 * What the token response gives an RP. The access token is opaque by design
 * (not a JWT) — the decodable payload lives in the ID token — so the useful
 * parts here are the grant metadata and computed expiry.
 * @param {{ token_type: string, scope?: string, expires_in?: number, access_token: string, id_token?: string }} tokens
 * @param {number} obtainedAt - epoch ms when the tokens were obtained
 */
export function tokenSummary(tokens, obtainedAt) {
  /** @param {string} [value] */
  const truncate = (value) =>
    value ? `${value.slice(0, 16)}… (${value.length} chars)` : undefined

  return {
    token_type: tokens.token_type,
    scope: tokens.scope,
    expires_in: tokens.expires_in,
    expires_at:
      tokens.expires_in !== undefined
        ? new Date(obtainedAt + tokens.expires_in * 1000).toISOString()
        : undefined,
    access_token: truncate(tokens.access_token),
    id_token: truncate(tokens.id_token)
  }
}

/**
 * The signed-in home page
 * @param {object} claims - ID token claims
 * @param {object} summary - token response summary
 * @param {object} userinfo - userinfo response
 */
export function signedInPage(claims, summary, userinfo) {
  return page(`
    <p>Signed in.</p>
    ${table('ID token claims', claims)}
    ${table('Token response', summary)}
    ${table('Userinfo (fetched with the access token)', userinfo)}
    <p><a href="/login">Sign in again</a> <a href="/logout">Sign out</a></p>`)
}

/** @param {string} message */
export function errorPage(message) {
  return page(
    `<p>Something went wrong:</p><pre>${escapeHtml(message)}</pre><p><a href="/">Home</a></p>`
  )
}
