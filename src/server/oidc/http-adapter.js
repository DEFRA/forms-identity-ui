import { config } from '~/src/config/index.js'
import {
  delJson,
  getJson,
  postJson,
  putJson
} from '~/src/server/common/helpers/fetch.js'

const IDENTITY_API_URL = config.get('identityApi.url')

/**
 * Converts an oidc-provider model name to its wire/collection name
 * (e.g. 'AuthorizationCode' -> 'authorization_code')
 * @param {string} name
 */
function snakeCase(name) {
  return name.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
}

/**
 * Swallows 404s (adapter contract: absent = undefined), rethrows anything
 * else
 * @param {unknown} err
 */
function throwUnless404(err) {
  if (
    err instanceof Error &&
    'isBoom' in err &&
    'output' in err &&
    /** @type {{ output: { statusCode: number } }} */ (err).output
      .statusCode === 404
  ) {
    return
  }
  throw err
}

/**
 * Builds an oidc-provider Adapter class whose persistence is
 * forms-identity-api's /oidc endpoints (the UI keeps no database).
 * oidc-provider instantiates it as `new Adapter(modelName)`.
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

    /** @param {string} path */
    url(path) {
      return new URL(`/oidc/${this.model}/${path}`, IDENTITY_API_URL)
    }

    /**
     * @param {string} id
     * @param {AdapterPayload} payload
     * @param {number} [expiresIn]
     */
    async upsert(id, payload, expiresIn) {
      await putJson(this.url(id), {
        payload: { payload, ...(expiresIn && { expiresIn }) }
      })
    }

    /** @param {string} id */
    async find(id) {
      try {
        const { body } = await getJson(this.url(id))
        return /** @type {AdapterPayload} */ (body)
      } catch (err) {
        throwUnless404(err)
        return undefined
      }
    }

    /** @param {string} uid */
    async findByUid(uid) {
      try {
        const { body } = await getJson(this.url(`uid/${uid}`))
        return /** @type {AdapterPayload} */ (body)
      } catch (err) {
        throwUnless404(err)
        return undefined
      }
    }

    /** @param {string} userCode */
    findByUserCode(userCode) {
      // Device flow is not enabled; satisfy the Adapter interface
      return this.find(userCode)
    }

    /** @param {string} id */
    async consume(id) {
      await postJson(this.url(`${id}/consume`), {})
    }

    /** @param {string} id */
    async destroy(id) {
      await delJson(this.url(id), {})
    }

    /** @param {string} grantId */
    async revokeByGrantId(grantId) {
      await delJson(new URL(`/oidc/grants/${grantId}`, IDENTITY_API_URL), {})
    }
  }

  return HttpAdapter
}

/**
 * @import { Adapter, AdapterConstructor, AdapterPayload } from 'oidc-provider'
 */
