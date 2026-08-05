/**
 * Minimal HTML rendering for the example RP — kept apart from the OIDC
 * wiring in index.mjs so each file does one thing.
 */

/** @param {unknown} value */
export function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
}

/** @param {string} body */
export function page(body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example RP</title></head><body><h1>Example RP</h1>${body}</body></html>`
}

/** @param {unknown} value */
function pre(value) {
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`
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
    <h2>ID token claims</h2>
    ${pre(claims)}
    <h2>Token response</h2>
    ${pre(summary)}
    <h2>Userinfo (fetched with the access token)</h2>
    ${pre(userinfo)}
    <p><a href="/login">Sign in again</a> <a href="/logout">Sign out</a></p>`)
}

/** @param {string} message */
export function errorPage(message) {
  return page(
    `<p>Something went wrong:</p><pre>${escapeHtml(message)}</pre><p><a href="/">Home</a></p>`
  )
}
