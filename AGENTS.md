# AGENTS.md

## Overview
- Single-file Express 5 API for a rental platform. `index.js` is the entire app: entrypoint, DB wiring, and all routes. Add new routes there — do not invent a `src/` structure.
- ESM only (`"type": "module"`) with top-level `await`. Needs a Node version supporting top-level await (14.8+).
- MongoDB via the official `mongodb` driver (no Mongoose). DB name `rental-platform`; collections: `users`, `equipment`, `bookings`, `payments`. All defined as module-level consts in `index.js`.
- Currently one route: `GET /equipment`.

## Commands
- Start server: `node index.js` — listens on port **5000** (hardcoded). There is no `start`/`dev` script.
- `npm test` is the npm stub (`exit 1`) — there are no tests, lint, or typecheck. Its failure is expected, not a regression.
- Install deps: `npm install` (`package-lock.json` → npm, not yarn/pnpm).

## Environment
- `.env` at repo root with `MONGODB_URI`, loaded via `import 'dotenv/config'`.
- Startup fails hard if Mongo is unreachable: `connectToMongoDB()` runs as top-level await and `connectedClient.db(...)` executes even when connect failed (catch returns `undefined`), so a bad URI/cert throws at boot.
- `.env` contains a live Atlas credential: never commit it, print it, or paste it into other files/logs.

## Gotchas
- `.gitignore` covers `node_modules/` and `.env` — keep both ignored; never force-add them (`git add -f`).
- Express **5** (not 4): async handler rejections go to the error handler automatically; path syntax is path-to-regexp v8 — use `/*splat`-style wildcards, plain `*` patterns fail.
- CORS is wide open (`app.use(cors())` with no options) — keep as-is unless asked to restrict origins.
- No remote, no CI, no pre-commit hooks yet (branch `main`, root commit `2f4c15d`).
