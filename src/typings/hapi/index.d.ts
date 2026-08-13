/* eslint-disable @typescript-eslint/no-unused-vars -- augmentation type parameters must repeat the originals even though nothing here reads them */
import {
  type Plugin,
  type ReqRef,
  type ReqRefDefaults,
  type ServerApplicationState
} from '@hapi/hapi'
import { type ServerYar, type Yar } from '@hapi/yar'
import type OidcProvider from 'oidc-provider'
import { type Logger } from 'pino'

declare module '@hapi/hapi' {
  // Here we are decorating Hapi interface types with
  // props from plugins which doesn't export @types
  interface PluginsStates {
    blankie?: {
      nonces?: {
        script?: string
        style?: string
      }
    }
  }

  // A route may carry its own CSP, which blankie uses in place of the
  // server-wide policy (or `false` to send none at all)
  interface PluginSpecificConfiguration {
    blankie?: Record<string, boolean | string | string[]> | false
  }

  // Augmented interfaces must repeat the originals' type parameters —
  // omitting them silently corrupts every generic use of the type
  interface Request<Refs extends ReqRef = ReqRefDefaults> {
    logger: Logger
    yar: Yar
  }

  interface Server<A = ServerApplicationState> {
    logger: Logger
    yar: ServerYar
  }

  interface ServerApplicationState {
    oidcProvider: OidcProvider
  }
}

declare module '@hapi/scooter' {
  declare const hapiScooter: {
    plugin: Plugin
  }

  export = hapiScooter
}

declare module 'blankie' {
  declare const blankie: {
    plugin: Plugin<Record<string, boolean | string | string[]>>
  }

  export = blankie
}

declare module 'blipp' {
  declare const blipp: {
    plugin: Plugin
  }

  export = blipp
}

declare module 'hapi-pulse' {
  declare const hapiPulse: {
    plugin: Plugin<{
      timeout: number
    }>
  }

  export = hapiPulse
}
