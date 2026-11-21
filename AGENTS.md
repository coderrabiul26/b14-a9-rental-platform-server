# AGENTS.md

## Overview
- Single-file Express 5 API for a rental platform. `index.js` is the entire app: entrypoint, DB wiring, and all routes. Add new routes there — do not invent a `src/` structure.
- ESM only (`"type": "module"`) with top-level `await`. Needs a Node version supporting top-level await (14.8+).
- MongoDB via the official `mongodb` driver (no Mongoose). DB name `rental-platform`. Better Auth owns the **singular** collections `user`, `session`, `account`, `verification` (there is no `users` collection — querying it matches 0 documents). The app's own collections are `equipment`, `bookings`, `favourites`, `payments`. All defined as module-level consts in `index.js`.
- Routes all live in `index.js`: equipment (`/api/addEquipment`, `/api/allEquipment`, `/api/equipmentDetails/:id`, `/api/ownerEquipment`, `/api/deleteEquipment/:id`), booking/favourites (`/api/addBooking`, `/api/addFavourite`), the booking-modal flow (`POST /api/prepareBooking` → validates dates/quantity, checks overlapping **paid** bookings, computes `amount = unitPrice × units × quantity`, stores a `payment_status:"pending"` row in `payments` and returns its `paymentId`; `GET /api/payment/:id` returns that row), user premium (`/api/user/:id/premium` → `{ premium: boolean }`) and Stripe (`POST /payment/checkout-verify`: for sessions with `metadata.paymentId` it writes the transaction onto the payment row, flips it to `paid`, and creates the booking record — idempotent on refresh; sessions without it take the legacy plan path). Always answer with JSON — `res.send(null)` sends an empty body and crashes the client's `response.json()`.

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
