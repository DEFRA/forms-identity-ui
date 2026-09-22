import { config } from '~/src/config/index.js'
import {
  delJson,
  getJson,
  postJson,
  putJson
} from '~/src/server/common/helpers/fetch.js'
import { hashId } from '~/src/server/common/helpers/hash-id.js'
import { serviceAuthHeaders } from '~/src/server/lib/service-token.js'

const IDENTITY_API_URL = config.get('identityApi.url')

/**
 * Converts an oidc-provider model name to its wire/collection name
 * (e.g. 'AuthorizationCode' -> 'authorization_code')
 * @param {string} name
 */
function snakeCase(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
}

/** The API's answer when an artifact is not stored */
const NO_CONTENT = 204

/**
 * The Adapter contract requires find/findByUid to resolve `undefined` for an
 * unknown id — oidc-provider probes the store as part of the protocol (is
 * there a session cookie? has this code been issued?), so the lookup can
 * never be skipped and "absent" is an expected answer, not a failure.
 *
 * Absent is the 204, and only the status says so: a bodiless response carries
 * no JSON content type, so it is read as an empty Buffer rather than null.
 * Testing the body instead would make every miss look like a hit holding an
 * empty payload.
 * @param {object} response
 * @param {unknown} body
 */
function toPayload(response, body) {
  const { statusCode } = /** @type {{ statusCode?: number }} */ (response)

  if (statusCode === NO_CONTENT) {
    return undefined
  }

  return /** @type {AdapterPayload} */ (body)
}

/**
 * Builds an oidc-provider Adapter class whose persistence is
 * forms-identity-api's /oidc endpoints (the UI keeps no database).
 * oidc-provider instantiates it as `new Adapter(modelName)`.
 *
 * Each call carries the caller credential as request headers, built by
 * serviceAuthHeaders from the current token.
 * @returns {AdapterConstructor}
 */
export function makeHttpAdapter() {
  /**
   * HTTP-backed oidc-provider adapter
   * @implements {Adapter}
   */
  class HttpAdapter {
    /**
     * @param {string} name - the oidc-provider model name (e.g. 'AuthorizationCode')
     */
    constructor(name) {
      this.model = snakeCase(name)
    }

    /**
     * The artifact's own URL. `oidc-provider` issues opaque tokens, so an
     * artifact's id is the credential the browser or relying party holds —
     * the path carries a digest of it so that the credential stays out of
     * every access log between here and the API.
     * @param {string} id
     * @param {string} [suffix] - trailing path segment, e.g. '/consume'
     */
    url(id, suffix = '') {
      return new URL(
        `/oidc/${this.model}/${hashId(id)}${suffix}`,
        IDENTITY_API_URL
      )
    }

    /**
     * @param {string} id
     * @param {AdapterPayload} payload
     * @param {number} [expiresIn]
     */
    async upsert(id, payload, expiresIn) {
      // The provider re-saves with the seconds an artifact has left, which
      // is 0 at the expiry boundary and negative once past it. Both must
      // still reach the API as an expiry: omitting it means "never expires",
      // which would strand an expired record beyond the TTL sweeper's reach.
      // The API's contract requires a positive value, so already-expired
      // artifacts get the shortest one it accepts.
      const ttl = Number.isFinite(expiresIn)
        ? Math.max(1, /** @type {number} */ (expiresIn))
        : undefined

      await putJson(this.url(id), {
        payload: { payload, ...(ttl !== undefined && { expiresIn: ttl }) },
        headers: await serviceAuthHeaders()
      })
    }

    /** @param {string} id */
    async find(id) {
      const { response, body } = await getJson(this.url(id), {
        headers: await serviceAuthHeaders()
      })
      return toPayload(response, body)
    }

    /**
     * Resolves against `payload.uid`, which the adapter stores verbatim, so
     * this one stays plaintext. The session uid is an internal reference
     * that no client is ever given.
     * @param {string} uid
     */
    async findByUid(uid) {
      const { response, body } = await getJson(
        new URL(
          `/oidc/${this.model}/uid/${encodeURIComponent(uid)}`,
          IDENTITY_API_URL
        ),
        { headers: await serviceAuthHeaders() }
      )
      return toPayload(response, body)
    }

    /** @param {string} userCode */
    findByUserCode(userCode) {
      // Device flow is not enabled; satisfy the Adapter interface
      return this.find(userCode)
    }

    /** @param {string} id */
    async consume(id) {
      await postJson(this.url(id, '/consume'), {
        headers: await serviceAuthHeaders()
      })
    }

    /** @param {string} id */
    async destroy(id) {
      await delJson(this.url(id), { headers: await serviceAuthHeaders() })
    }

    /**
     * Resolves against `payload.grantId`, stored verbatim, so this one stays
     * plaintext for the same reason as `findByUid`.
     * @param {string} grantId
     */
    async revokeByGrantId(grantId) {
      await delJson(
        new URL(
          `/oidc/grants/${encodeURIComponent(grantId)}`,
          IDENTITY_API_URL
        ),
        { headers: await serviceAuthHeaders() }
      )
    }
  }

  return HttpAdapter
}

/**
 * @import { Adapter, AdapterConstructor, AdapterPayload } from 'oidc-provider'
 */
