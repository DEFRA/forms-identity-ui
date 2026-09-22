import { generateClientKeypair, generateJwks } from '~/scripts/jwks.cjs'

describe('key generation', () => {
  describe('the provider signing key', () => {
    it('is an RS256 key', () => {
      const [key] = generateJwks().keys

      expect(key.kty).toBe('RSA')
      expect(key.alg).toBe('RS256')
      expect(key.use).toBe('sig')
      expect(key.kid).toMatch(/^sig-rs256-[0-9a-f]{12}$/)
    })

    it('is private, carrying the material that signs', () => {
      const [key] = generateJwks().keys

      expect(key.d).toBeDefined()
    })
  })

  describe('the client assertion key', () => {
    it('is an RS256 key', () => {
      const { public: publicJwks, private: privateJwks } =
        generateClientKeypair()
      const [publicKey] = publicJwks.keys
      const [privateKey] = privateJwks.keys

      expect(publicKey.kty).toBe('RSA')
      expect(publicKey.alg).toBe('RS256')
      expect(publicKey.kid).toMatch(/^runner-rs256-[0-9a-f]{12}$/)
      expect(privateKey.kid).toBe(publicKey.kid)
    })

    it('keeps the signing material out of the half this service holds', () => {
      const { public: publicJwks, private: privateJwks } =
        generateClientKeypair()

      expect(publicJwks.keys[0].d).toBeUndefined()
      expect(privateJwks.keys[0].d).toBeDefined()
    })
  })
})
