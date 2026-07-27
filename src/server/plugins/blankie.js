import Blankie from 'blankie'

/**
 * Content Security Policy using blankie
 * @satisfies {ServerRegisterPluginObject<Record<string, boolean | string | string[]>>}
 */
export default {
  plugin: Blankie,
  options: {
    defaultSrc: ['self'],
    baseUri: ['none'],
    fontSrc: ['self', 'data:'],
    connectSrc: ['self'],
    scriptSrc: ['self'],
    styleSrc: ['self'],
    imgSrc: ['self', 'data:'],
    frameSrc: ['none'],
    formAction: ['self'],
    frameAncestors: ['none'],
    objectSrc: ['none'],
    generateNonces: 'script'
  }
}

/**
 * @import { ServerRegisterPluginObject } from '@hapi/hapi'
 */
