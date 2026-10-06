import 'oidc-provider'

declare module 'oidc-provider' {
  // node-oidc-provider publishes this but it's missing from the exported
  // types. Patch it here so our type checks pass.
  namespace Client {
    const Schema: {
      prototype: {
        invalidate: (message: string, code?: string) => void
      }
    }
  }
}
