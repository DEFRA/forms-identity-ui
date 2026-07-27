import { type Plugin } from '@hapi/hapi'
import { type ServerYar, type Yar } from '@hapi/yar'
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

  interface Request {
    logger: Logger
    yar: Yar
  }

  interface Server {
    logger: Logger
    yar: ServerYar
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
