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
