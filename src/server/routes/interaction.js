import Boom from '@hapi/boom'
import { StatusCodes } from 'http-status-codes'
import Joi from 'joi'
import { errors } from 'oidc-provider'

import { config } from '~/src/config/index.js'
import { formatDuration } from '~/src/server/common/helpers/duration.js'
import { signinFormCsp } from '~/src/server/plugins/blankie.js'
import * as signinService from '~/src/server/services/signin-service.js'

// how long the timed-out page tells the user they had, taken from the
// setting that actually ends the interaction so the two cannot disagree
const INTERACTION_DURATION = formatDuration(config.get('oidc.ttl.interaction'))

const uidParams = Joi.object({ uid: Joi.string().required() })

/**
 * Each form posts exactly one field plus the crumb. A duplicated key makes
 * hapi parse the field as an array, so its type is pinned at the boundary —
 * the handlers and the signin service only ever see a string or nothing.
 * @param {string} field
 */
function formPayload(field) {
  return Joi.object({
    crumb: Joi.string().optional(),
    [field]: Joi.string().allow('').optional()
  })
}

/* eslint-disable jsdoc/reject-any-type -- hapi request refs are invariant, so only any-ref helpers can be shared by payload-narrowed routes */

/**
 * Security gate. Checks that this browser is the one that started the
 * sign-in: the uid in the URL must match the signed cookie the provider
 * set. Without this check, anyone could guess a uid and see another
 * person's sign-in details, such as their email address.
 *
 * Every /interaction route must run this as a pre step — the server
 * refuses to start if one is missing it (see assertInteractionRoutesGated
 * below).
 *
 * If the sign-in has expired or the cookie is missing, the user sees the
 * timed-out page. Any other failure becomes a 500 error page.
 * @param {Request<any>} request
 * @param {ResponseToolkit<any>} h
 */
export async function requireInteraction(request, h) {
  const provider = request.server.app.oidcProvider

  try {
    return await provider.interactionDetails(request.raw.req, request.raw.res)
  } catch (err) {
    if (err instanceof errors.SessionNotFound) {
      return h
        .view('interaction/timed-out', {
          interactionDuration: INTERACTION_DURATION
        })
        .code(StatusCodes.GONE)
        .takeover()
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
  let checked = 0

  for (const route of server.table()) {
    if (!route.path.startsWith('/interaction')) {
      continue
    }

    checked++

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

  // The guard recognises its routes by path, so a rename or a prefixed
  // mount would leave it silently inspecting nothing at all. Finding none
  // means the guard has lost track of them, not that there are none.
  if (!checked) {
    throw new Error(
      'Found no interaction routes to check for the gate — the guard is looking for paths under /interaction'
    )
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
      options: {
        validate: { params: uidParams, payload: formPayload('email') },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        const { email } = request.payload
        const result = await signinService.submitEmail(details.uid, email)

        if (result.outcome === signinService.INVALID_EMAIL) {
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
      options: {
        validate: { params: uidParams },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        // display-only, from the API's stored record — the same source
        // verification uses
        const email = await signinService.getSigninEmail(details.uid)

        // no code has been requested yet, so there is nothing to check and
        // no address to show: start the journey where it actually begins
        if (!email) {
          return h.redirect(`/interaction/${details.uid}`)
        }

        return h.view('interaction/code', { uid: details.uid, email })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { code?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/interaction/{uid}/code',
      options: {
        validate: { params: uidParams, payload: formPayload('code') },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        const { code } = request.payload
        const result = await signinService.submitCode(details.uid, code)

        if (result.outcome === signinService.SIGNED_IN) {
          return finishLogin(request, h, result.accountId)
        }
        if (result.outcome === signinService.PHONE_REQUIRED) {
          return h.redirect(`/interaction/${details.uid}/phone`)
        }

        const email = await signinService.getSigninEmail(details.uid)

        // the record backing this page is gone (expired, or never requested),
        // so re-rendering would offer another attempt that cannot succeed
        if (!email) {
          return h.redirect(`/interaction/${details.uid}`)
        }

        return h.view('interaction/code', {
          uid: details.uid,
          email,
          errorKey: result.errorKey
        })
      }
    }),
    /** @satisfies {ServerRoute<{ Pres: InteractionPres }>} */
    ({
      method: 'GET',
      path: '/interaction/{uid}/phone',
      options: {
        validate: { params: uidParams },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      handler(request, h) {
        return h.view('interaction/phone', { uid: request.pre.details.uid })
      }
    }),
    /** @satisfies {ServerRoute<{ Payload: { phone?: string }, Pres: InteractionPres }>} */
    ({
      method: 'POST',
      path: '/interaction/{uid}/phone',
      options: {
        validate: { params: uidParams, payload: formPayload('phone') },
        plugins: { blankie: signinFormCsp },
        pre: [GATE]
      },
      async handler(request, h) {
        const details = request.pre.details
        const { phone } = request.payload
        // Account creation happens in forms-identity-api: its POST /accounts
        // verifies the interaction's OTP state, creates the account with the
        // validated phone (existing accounts sign in at the code step and
        // never reach this page) and returns signed-in with the account id
        const result = await signinService.submitPhone(details.uid, phone)

        if (result.outcome === signinService.SIGNED_IN) {
          return finishLogin(request, h, result.accountId)
        }
        if (result.outcome === signinService.INVALID_PHONE) {
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
