import Boom from '@hapi/boom'
import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'
import { errors } from 'oidc-provider'

import * as signinService from '~/src/server/services/signin-service.js'

const uidParams = Joi.object({ uid: Joi.string().required() })

/* eslint-disable jsdoc/reject-any-type -- hapi request refs are invariant, so only any-ref helpers can be shared by payload-narrowed routes */

/**
 * The gate every interaction route runs behind, as a pre step: resolves the
 * interaction from the provider, which validates the signed interaction
 * cookie against the uid — a uid alone, without the browser that started
 * the flow, never matches, so no handler can leak another interaction's
 * data. A dead interaction (expired or cookieless) renders the timed-out
 * view; only the RP can mint a new one via /auth. Anything else (e.g. the
 * persistence tier being down) surfaces as a 500 through the error-pages
 * plugin, not a timeout.
 * @param {Request<any>} request
 * @param {ResponseToolkit<any>} h
 */
export async function requireInteraction(request, h) {
  const provider = request.server.app.oidcProvider

  try {
    return await provider.interactionDetails(request.raw.req, request.raw.res)
  } catch (err) {
    if (err instanceof errors.SessionNotFound) {
      return h.view('interaction/timed-out').code(StatusCodes.GONE).takeover()
    }
    throw err
  }
}

/** The pre entry every /interaction route must carry */
const GATE = {
  method: requireInteraction,
  assign: /** @type {const} */ ('details')
}

/**
 * Startup guard called from the router: the server refuses to boot if any
 * /interaction route is missing the gate, so forgetting the pre entry on a
 * new route is a crash on first start (and in every test that builds the
 * server), never a deployed security hole.
 * @param {Server} server
 */
export function assertInteractionRoutesGated(server) {
  for (const route of server.table()) {
    if (!route.path.startsWith('/interaction')) {
      continue
    }

    const pre = /** @type {unknown[]} */ (route.settings.pre ?? []).flat()
    const gated = pre.some(
      (entry) =>
        entry === requireInteraction ||
        (typeof entry === 'object' &&
          entry !== null &&
          'method' in entry &&
          entry.method === requireInteraction)
    )

    if (!gated) {
      throw new Error(
        `Route ${route.method.toUpperCase()} ${route.path} is missing the interaction gate (requireInteraction pre)`
      )
    }
  }
}

/**
 * Completes the OIDC interaction with a signed-in account. The provider
 * writes the resume redirect straight to the socket, so the handler must
 * return h.abandon.
 * @param {Request<any>} request
 * @param {ResponseToolkit<any>} h
 * @param {string} accountId
 */
async function finishLogin(request, h, accountId) {
  await request.server.app.oidcProvider.interactionFinished(
    request.raw.req,
    request.raw.res,
    { login: { accountId } },
    { mergeWithLastSubmission: false }
  )
  return h.abandon
}

/**
 * Sign-in interaction pages. Every route runs behind the requireInteraction
 * pre (request.pre.details); handlers hand raw request data to the signin
 * service and translate the returned outcome into a response. Rendering is
 * optimistic; every submission is enforced by the API's otps state machine —
 * identity only ever derives from server-side state. Crumb protects every
 * POST (the hidden field is in each form); the protocol endpoints in the
 * oidc plugin are the only crumb-exempt routes.
 *
 * Payload and pre shapes are typed per route (satisfies annotations), so
 * handlers read request.payload and request.pre without casts; hapi types
 * server.route() with default request refs only, so the narrowed routes
 * collapse to ServerRoute[] at this export boundary.
 */
export default /** @type {ServerRoute[]} */ (
  /** @type {unknown[]} */ ([
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/interaction/{uid}',
      options: { validate: { params: uidParams }, pre: [GATE] },
      async handler(request, h) {
        const details = request.pre.details
        const provider = request.server.app.oidcProvider

        // Consent is auto-granted: this provider serves exactly one
        // first-party client, so there is no permission to ask the user
        // about. oidc-provider leaves consent policy to the deployment
        // (devInteractions is disabled), which is why the grant is built
        // here rather than by the library.
        if (details.prompt.name === 'consent') {
          const params = /** @type {{ client_id?: string, scope?: string }} */ (
            details.params
          )
          // Record which scopes the account grants the client. The scope is
          // the authorization request's own ('openid email' from runner),
          // already validated by the provider; the fallback only satisfies
          // the loose params typing. The saved grant id is the complete
          // consent result — the login half was submitted in the earlier
          // step and merges in via mergeWithLastSubmission.
          const grant = new provider.Grant({
            accountId: details.session?.accountId,
            clientId: params.client_id
          })
          grant.addOIDCScope(params.scope ?? '')
          const grantId = await grant.save()
          await provider.interactionFinished(
            request.raw.req,
            request.raw.res,
            { consent: { grantId } },
            { mergeWithLastSubmission: true }
          )
          return h.abandon
        }

        // login and consent are the only prompts this provider's
        // configuration can produce — anything else means the provider and
        // this handler have drifted apart, which is our bug, not the user's
        if (details.prompt.name !== 'login') {
          throw Boom.badImplementation(
            `Unsupported interaction prompt: ${details.prompt.name}`
          )
        }

        return h.view('interaction/email', { uid: details.uid })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { email?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/interaction/{uid}/email',
      options: { validate: { params: uidParams }, pre: [GATE] },
      async handler(request, h) {
        const details = request.pre.details
        const { email } = request.payload
        const result = await signinService.submitEmail(details.uid, email)

        if (result.outcome === 'invalid-email') {
          return h.view('interaction/email', {
            uid: details.uid,
            email: result.email,
            errorKey: result.errorKey
          })
        }

        return h.redirect(`/interaction/${details.uid}/code`)
      }
    }),
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/interaction/{uid}/code',
      options: { validate: { params: uidParams }, pre: [GATE] },
      async handler(request, h) {
        const details = request.pre.details

        return h.view('interaction/code', {
          uid: details.uid,
          // display-only, from the API's stored record — the same source
          // verification uses
          email: await signinService.getSigninEmail(details.uid)
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/interaction/{uid}/code',
      options: { validate: { params: uidParams }, pre: [GATE] },
      async handler(request, h) {
        const details = request.pre.details
        const { code } = request.payload
        const result = await signinService.submitCode(details.uid, code)

        if (result.outcome === 'signed-in') {
          return finishLogin(request, h, result.accountId)
        }
        if (result.outcome === 'phone-required') {
          return h.redirect(`/interaction/${details.uid}/phone`)
        }

        return h.view('interaction/code', {
          uid: details.uid,
          email: await signinService.getSigninEmail(details.uid),
          errorKey: result.errorKey
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/interaction/{uid}/phone',
      options: { validate: { params: uidParams }, pre: [GATE] },
      handler(request, h) {
        return h.view('interaction/phone', { uid: request.pre.details.uid })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { phone?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/interaction/{uid}/phone',
      options: { validate: { params: uidParams }, pre: [GATE] },
      async handler(request, h) {
        const details = request.pre.details
        const { phone } = request.payload
        // Account creation happens in forms-identity-api: its POST /accounts
        // verifies the interaction's OTP state, creates the account with the
        // validated phone (existing accounts sign in at the code step and
        // never reach this page) and returns signed-in with the account id
        const result = await signinService.submitPhone(details.uid, phone)

        if (result.outcome === 'signed-in') {
          return finishLogin(request, h, result.accountId)
        }
        if (result.outcome === 'invalid-phone') {
          return h.view('interaction/phone', {
            uid: details.uid,
            phone: result.phone,
            errorKey: result.errorKey
          })
        }

        // out of order / replay — restart the journey at the email page
        return h.redirect(`/interaction/${details.uid}`)
      }
    })
  ])
)

/**
 * @import { Request, ResponseToolkit, Server, ServerRoute } from '@hapi/hapi'
 * @typedef {Awaited<ReturnType<import('oidc-provider').default['interactionDetails']>>} InteractionDetails
 * @typedef {{ details: InteractionDetails }} InteractionPres
 */
