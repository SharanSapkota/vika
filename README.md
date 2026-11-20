# Vika

A CLI that reads server logs and git history, finds error patterns that first
appeared after a deploy, and names the suspect commit/PR with a confidence level.

## Setup

Needs Node.js 20.12+ and Docker.

```sh
npm install
cp .env.example .env
```

## Start Postgres

```sh
docker compose up -d --wait db          # dev database on localhost:5433 (data kept in a named volume)
```

## Run tests

Tests use a separate, throwaway database on port 5434. Its data lives in memory,
so it is wiped whenever the container stops.

```sh
docker compose --profile test up -d --wait db-test
npm test
docker compose --profile test rm -sf db-test   # throw it away
```

## Other scripts

```sh
npm run typecheck   # type-check src and tests
npm run build       # compile src/ to dist/
node dist/cli.js --help
```
