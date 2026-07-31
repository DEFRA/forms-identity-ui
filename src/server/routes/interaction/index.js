import { makeInteractionController } from '~/src/server/routes/interaction/controller.js'

/**
 * Sign-in interaction routes. Crumb protects every POST (the hidden field is
 * in each form); the protocol endpoints in the oidc plugin are the only
 * crumb-exempt routes.
 * @returns {ServerRoute[]}
 */
export function interactionRoutes() {
  const controller = makeInteractionController()

  return [
    {
      method: 'GET',
      path: '/ui/interaction/{uid}',
      handler: controller.entry
    },
    {
      method: 'POST',
      path: '/ui/interaction/{uid}/email',
      handler: controller.submitEmail
    },
    {
      method: 'GET',
      path: '/ui/interaction/{uid}/code',
      handler: controller.showCode
    },
    {
      method: 'POST',
      path: '/ui/interaction/{uid}/code',
      handler: controller.submitCode
    },
    {
      method: 'GET',
      path: '/ui/interaction/{uid}/phone',
      handler: controller.showPhone
    },
    {
      method: 'POST',
      path: '/ui/interaction/{uid}/phone',
      handler: controller.submitPhone
    },
    {
      method: 'GET',
      path: '/ui/interaction/{uid}/expired',
      handler: controller.showExpired
    }
  ]
}

/**
 * @import { ServerRoute } from '@hapi/hapi'
 */
