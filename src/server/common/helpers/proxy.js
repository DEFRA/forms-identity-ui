import { config } from '~/src/config/index.js'

/**
 * undici's fetch() already decompresses the body before arrayBuffer(), so the
 * upstream content-encoding/content-length (which describe the *compressed*
 * bytes) must not be forwarded onto the decompressed body we actually send.
 * Node derives a correct Content-Length from the re-materialised buffer on
 * res.end(buffer). transfer-encoding is likewise stale once buffered.
 * set-cookie is skipped here and fanned out separately via getSetCookie().
 */
const SKIP_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'content-encoding',
  'content-length',
  'transfer-encoding'
])

/**
 * RFC 7230 §6.1 hop-by-hop headers: meaningful only for a single
 * transport-level connection and must not be relayed by a proxy onto the
 * next hop.
 */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate'
])

/**
 * Forward the inbound request to the private identity API and relay the raw
 * upstream response (status, headers, set-cookies and body) back to the
 * client, bypassing hapi's response lifecycle via h.abandon.
 *
 * The X-Forwarded-Proto/Host headers are derived from the façade's own
 * configured public issuer — not from the (untrusted, and locally wrong)
 * inbound client Host — so the backend always sees the scheme/host it should
 * mint discovery/redirect URLs against.
 * @param {Request} request - inbound request (cookies and remaining headers are forwarded)
 * @param {ResponseToolkit} h
 * @param {{ body?: URLSearchParams }} [options] - optional replacement body. When set, the
 *   forwarded body is the re-encoded form (used by the crumb-protected complete
 *   route, whose parsed payload has had the crumb consumed by `@hapi/crumb`) and
 *   the stale inbound content-length is dropped
 */
export async function proxyToIdentityApi(request, h, options = {}) {
  const issuerUrl = new URL(config.get('oidc.issuer'))
  const target =
    config.get('identityApi.url') + request.path + (request.url.search || '')

  const inboundHeaders = /** @type {Record<string, string>} */ (request.headers)
  /** @type {Record<string, string>} */
  const headers = {}
  for (const [name, value] of Object.entries(inboundHeaders)) {
    if (name === 'host' || HOP_BY_HOP_REQUEST_HEADERS.has(name)) {
      continue
    }
    headers[name] = value
  }
  headers['x-forwarded-proto'] = issuerUrl.protocol.replace(':', '')
  headers['x-forwarded-host'] = issuerUrl.host
  headers['x-forwarded-for'] = request.info.remoteAddress

  /** @type {BodyInit | undefined} */
  let body
  if (options.body) {
    // Re-encoded form replaces the parsed inbound payload, so the inbound
    // content-length no longer matches; fetch derives a fresh one.
    delete headers['content-length']
    headers['content-type'] = 'application/x-www-form-urlencoded'
    body = options.body.toString()
  } else if (request.method !== 'get' && request.method !== 'head') {
    // Unparsed proxied payloads are raw Buffers (`payload: { parse: false }`)
    body = /** @type {BodyInit} */ (request.payload)
  }

  let upstream
  try {
    upstream = await fetch(target, {
      method: request.method.toUpperCase(),
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(config.get('identityApi.timeoutMs'))
    })
  } catch {
    // Covers both an AbortError (timeout) and any other fetch rejection (e.g.
    // the backend connection is refused/reset) — either way the RP must get a
    // raw, proxy-shaped error, not our templated HTML error page.
    const { res } = request.raw
    res.statusCode = 504
    res.end('Gateway Timeout')
    return h.abandon
  }

  const { res } = request.raw
  res.statusCode = upstream.status
  upstream.headers.forEach((value, key) => {
    if (SKIP_RESPONSE_HEADERS.has(key)) {
      return // set-cookie handled below; others re-derived below
    }
    res.setHeader(key, value)
  })
  for (const cookie of upstream.headers.getSetCookie()) {
    res.appendHeader('set-cookie', cookie)
  }
  const buf = Buffer.from(await upstream.arrayBuffer())
  res.end(buf)
  return h.abandon // bypass onPreResponse catchAll + CSP
}

/**
 * @import { Request, ResponseToolkit } from '@hapi/hapi'
 */
