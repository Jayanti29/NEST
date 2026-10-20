# Architecture

NEST is a small npm-workspaces monorepo. The Vite React client calls an Express API through `/api`. The API uses SQLite through Node's built-in `node:sqlite`, initializes the local schema on boot, and inserts fictional seed data. The client never calls external device or AI endpoints.

## Current request flow

1. The client loads a selected fictional profile, routine, events, device list and care summary.
2. A person action calls an API route; request data is validated with Zod.
3. The API writes the response or simulated event to SQLite and returns a structured JSON envelope.
4. The care views refresh and render the recorded state, with source labels.
5. The mock assistant maps a small set of intents to application reads or a caregiver check-in action. Its structured tool results are shown in the Talk screen.

## Boundaries

- The simulator writes only `simulated` provenance. There is no real-device ingestion route.
- The AI implementation is an offline deterministic mock; it is not a Bedrock integration yet.
- All records are fictional and local. Session authentication, caregiver authorization and production privacy controls are not implemented.
- A future device adapter would need server-to-server credentials, consent, webhook verification, explicit authorization, and additional tests before any Ring API calls.

## Development

`npm run dev` starts the Express API on port 3001 and Vite on port 5173. Vite proxies `/api` to the API. `npm run build` compiles the client and server.
