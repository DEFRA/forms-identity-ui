# forms-identity-ui

Defra Forms identity frontend — the public sign-in façade for Defra Forms identity. A Hapi + nunjucks GOV.UK frontend service.

## Requirements

- Node.js `^22.11.0` — install via [nvm](https://github.com/nvm-sh/nvm) with `nvm use` (see `.nvmrc`)
- npm `>=10.9.0`

## Setup

```sh
nvm use
npm install
```

Configuration is via environment variables — see `.env.sample` for the available options. All have sensible defaults for local development, so no `.env` file is needed to get started.

## Development

```sh
npm run dev
```

Runs the webpack client watch and the server (via `tsx watch`) concurrently on http://localhost:3002.

### Local Redis

The session cache uses an in-memory engine by default in development. To use Redis instead:

```sh
docker compose up -d redis
```

then set `SESSION_CACHE_ENGINE=redis` in your `.env` file.

## Sign in flow

This service is the public sign-in façade for Defra Forms identity (DF-1160). It renders the
GOV.UK sign-in pages and reverse-proxies the OIDC protocol endpoints to the private
`forms-identity-api`, which has no public ingress:

```
citizen's browser ──▶ forms-identity-ui   :3002  public façade (this repo)
                        │  reverse-proxies OIDC endpoints (/.well-known, /auth, /token, /me,
                        │  /jwks, /session, GET /interaction/{uid}); renders the sign-in pages;
                        │  calls /otp/request server-to-server; forwards the crumb-validated
                        │  POST /interaction/{uid}/complete
                        ▼
                     forms-identity-api  :4001  private OIDC provider (Hapi + node-oidc-provider)
                        │
                        ▼           GOV.UK Notify (email delivery of the security code)
                      MongoDB
```

The OIDC issuer advertised to relying parties is this façade's own public URL (`OIDC_ISSUER`).
The proxy derives `X-Forwarded-Proto`/`X-Forwarded-Host` from that configured issuer — never
from the inbound `Host` header — and the API trusts them to mint discovery/redirect URLs. All
cookies are first-party to the façade origin. If the API is unreachable, proxied endpoints
return a raw `504 Gateway Timeout` (proxy-shaped, not a templated error page) by design.

### Browser walkthrough

1. The relying party (forms-runner) redirects the browser to `{issuer}/auth?...` (Authorization
   Code + PKCE). The provider (via the proxy) 302s login prompts to `{issuer}/ui/interaction/{uid}`.
2. `GET /ui/interaction/{uid}` renders the email page ("Sign in to save your progress").
3. `POST /ui/interaction/{uid}/email` (crumb-protected) validates the address, calls the API's
   `/otp/request` server-to-server (the code only ever reaches the citizen's inbox), and renders
   the code page.
4. The code page posts to `POST /interaction/{uid}/complete` (crumb-protected). After crumb
   validation the façade re-encodes `email` + `code` and forwards them — with the browser's
   cookies and `X-Forwarded-*` intact — through the proxy to the API's atomic verify+complete
   endpoint. Success 302s into the provider resume (`/auth/{uid}`); a rejected code 302s back to
   `GET /ui/interaction/{uid}/verify?email=...&error=1`, which re-renders the code page with an
   error.
5. The resumed flow auto-grants consent for the first-party `runner` client and returns the
   browser to the RP callback with an authorization code, which the RP exchanges at `/token`.

### Running the full flow locally

- **API** (`forms-identity-api`, port 4001): needs MongoDB (docker compose replicaset), an
  `OIDC_JWKS` + `OIDC_COOKIE_KEYS` pair (see its `scripts/generate-jwks.mjs`) and GOV.UK Notify
  credentials (`GOV_NOTIFY_API_KEY`, `GOV_NOTIFY_OTP_TEMPLATE_ID`) — `PORT=4001 npm run dev`.
- **Façade** (this repo, port 3002): `npm run dev` (defaults point at `http://localhost:4001`;
  redis optional, see above).

### Smoke test

`scripts/smoke.mjs` runs an in-process mock relying party on :3000 and drives the whole flow
with a cookie-jar "browser" that is asserted to never contact the private API directly. It
scrapes the crumb tokens from the rendered pages like a real browser. There is no OTP backdoor:
run it once to trigger the email, then re-run with the received code:

```sh
SMOKE_EMAIL=you@example.com node scripts/smoke.mjs
SMOKE_EMAIL=you@example.com SMOKE_OTP_CODE=123456 node scripts/smoke.mjs
```

## Testing and linting

```sh
npm test          # jest with coverage
npm run lint      # editorconfig + eslint + tsc
npm run lint:scss # stylelint
npm run format    # prettier write
```

## Production build

```sh
npm run build # babel server build to .server, webpack client build to .public
npm start     # build then serve on PORT (default 3002)
```

## Licence

THIS INFORMATION IS LICENSED UNDER THE CONDITIONS OF THE OPEN GOVERNMENT LICENCE found at:

http://www.nationalarchives.gov.uk/doc/open-government-licence/version/3

The following attribution statement MUST be cited in your products and applications when using this information.

> Contains public sector information licensed under the Open Government licence v3

### About the licence

The Open Government Licence (OGL) was developed by the Controller of Her Majesty's Stationery Office (HMSO) to enable information providers in the public sector to license the use and re-use of their information under a common open licence.

It is designed to encourage use and re-use of information freely and flexibly, with only a few conditions.
