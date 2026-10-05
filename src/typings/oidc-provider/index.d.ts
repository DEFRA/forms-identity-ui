import 'oidc-provider'

declare module 'oidc-provider' {
  // The class that validates client metadata. The published types leave it
  // out; the library exposes it so that a deployment can adjust a check.
  namespace Client {
    const Schema: {
      prototype: {
        invalidate: (message: string, code?: string) => void
      }
    }
  }
}
