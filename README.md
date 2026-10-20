# NEST — A home that adapts to you

NEST is a simulated adaptive living companion for older adults and people with disabilities. It brings daily routines, alternative communication, simulated home events and caregiver review into one accessible web app. The demo uses fictional profiles and labels simulated data wherever it appears.

## Run locally

Requirements: Node.js 22.13+ (the project uses the built-in `node:sqlite` module) and npm.

```sh
npm install
npm run dev
```

Open the Vite URL printed by the client (usually `http://localhost:5173`). The Express API runs on port 3001 and persists demo data in `nest.sqlite`. Use `npm run build` to create production bundles; `npm start` starts the API server. Copy `.env.example` to `.env` to configure the server. Set the file permissions to owner-only (`chmod 600 .env`) and never commit it.

## What is included

- My Day, Talk or Tap, My Routine, Home Status, Care Circle, and Settings and Simulator screens.
- A real Express API backed by SQLite, seeded with four fictional profiles, daily routine items and clearly simulated devices/events.
- Reminder acknowledgements, picture requests with an eight-second undo endpoint, caregiver check-ins and a simulator event timeline.
- An offline mock assistant that calls narrow application tools and displays the structured results to the user.
- Speech synthesis for assistant replies, keyboard focus states, responsive layouts, large text controls, reduced-motion support, and clear labels for missing or simulated information.

## Hackathon track fit

The project follows the attached NEST Developer Build Specification and uses the Alexa+ simulated-experience path described in the Build, Ship, Shape hackathon resources. The simulator remains available. The Ring Playground makes read-only, server-to-server calls to Ring. OAuth tokens are encrypted in the existing SQLite database using AES-256-GCM and a local key; they are never sent to the browser or logged. Ring data is fetched only when a user invokes an endpoint and is not mixed with simulated NEST events.

Ring credentials belong in the ignored local `.env`: `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, `RING_WEBHOOK_HMAC_KEY`, and a generated base64 32-byte `RING_TOKEN_ENCRYPTION_KEY`. One-way Ring account linking also requires `RING_PARTNER_ACCOUNT_IDENTIFIER` (the account identifier to show Ring, in the app's configured masked form) and `RING_LINK_PASSWORD` (the local NEST account sign-in password). Keep `.env` owner-only (`chmod 600 .env`) and never share or commit it. Credential CSV files are ignored by Git. Do not paste tokens or secrets into issues, source files, or chat.

The configured Ring Console settings page exposes the one-way (Ring-driven) fields: Account Link URL, Default Redirect URL, Token Exchange URL, and Webhook URL. Once a publicly reachable HTTPS host exists, register `/api/ring/link`, `/api/ring/oauth/token-exchange`, and `/api/ring/webhook` on that host in **staging** first. The token exchange endpoint accepts Ring's JSON authorization-code request, immediately exchanges the one-time code and looks up `/v1/users/me`, then stores the account's tokens as encrypted and unclaimed. The link page requires the configured NEST identifier/password, checks the documented 10-minute HMAC-SHA256 nonce, and completes Ring's POST then PATCH integration lifecycle. Ring webhook signatures are checked against the raw body; duplicate webhook request IDs are ignored, and integration removal deletes stored tokens. The Ring console URL fields remain blank; `localhost` is not publicly reachable HTTPS, so live account linking and webhooks cannot work until the app is hosted and those staging fields are saved. Production remains untouched.

The Ring playground shows Connected only after an authenticated Ring API request succeeds. Stored tokens refresh on demand before expiry; refresh token rotation is persisted with a SQLite compare-and-swap lease so concurrent requests cannot store stale credentials. Invalid grants require reauthorization. A legacy `RING_ACCESS_TOKEN` remains supported for temporary, server-side read-only testing, but it does not enable persistent account linking.

The VS Code workspace includes the Ring Appstore Knowledge MCP server in `.vscode/settings.json` for GitHub Copilot Chat. It searches and retrieves Ring developer documentation; it does not access Ring accounts, devices, or tokens. The same server can be configured in other supported coding assistants by following [Ring's setup guide](https://developer.amazon.com/docs/ring/ring-mcp.html).

The AWS Builder mini-challenge is optional. No AWS credentials were supplied, and this build does not call Bedrock. Do not describe AWS as an integration in a submission unless Bedrock is configured and demonstrated.

## Data, safety and privacy

The seeded people are fictional. Acknowledging a reminder records a response only; it does not confirm that an activity happened. A missing device report is shown as **No data received**. NEST does not assess whether anyone is safe, diagnose, provide medical advice, send caregiver notifications, capture audio or video, or replace human care or emergency services. Reset demo clears recorded responses, requests, check-ins and events for the local demo database.

This is a hackathon prototype, not a production account system. It currently has no user authentication or caregiver authorization boundary and must not be deployed with real personal or health information. The app's caregiver view is for fictional demo data only.

## API overview

All JSON responses use `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | API and provider status |
| GET | `/api/people` | Fictional demo profiles |
| GET | `/api/people/:id/day` | Current plan and next item |
| GET | `/api/people/:id/routine` | Daily activities and responses |
| POST | `/api/occurrences/:id/respond` | Acknowledge, postpone, decline, or ask for help |
| GET | `/api/people/:id/devices` | Listed devices and honest no-data state |
| GET | `/api/people/:id/events` | Simulated event timeline |
| POST | `/api/sim/events` | Add a labeled simulator event |
| POST | `/api/sim/reset` | Reset the demo state |
| POST | `/api/people/:id/requests` | Create a picture/tap request |
| POST | `/api/requests/:id/undo` | Undo a request within eight seconds |
| POST/GET | `/api/people/:id/checkins` | Create or list caregiver check-ins |
| PATCH | `/api/checkins/:id` | Mark a check-in seen or resolved |
| GET | `/api/people/:id/care/summary` | Care Circle needs-review counts |
| GET | `/api/people/:id/care/timeline` | Merged caregiver timeline |
| POST | `/api/people/:id/assistant` | Offline tool-based assistant |

The Ring Playground proxies the documented read endpoints for users, device list/detail, status, capabilities, location, configurations and event history. These requests go from Express to `https://api.amazonvision.com`; the browser never receives Ring tokens. The UI distinguishes missing configuration, authorization required, refresh failure, reauthorization required, and a connection verified by a successful API response. It never substitutes simulated events for a failed Ring request. This local prototype has no general user/caregiver authorization model; do not expose its demo or Ring APIs publicly as a production service.

## Hackathon submission checklist

The code repository and running app are only part of a submission. Record a short demo video, write the project description and product feedback, choose the track, and submit through Devpost. Be accurate about simulator-only events and any integrations that have not been activated.

## License

MIT. See [LICENSE](LICENSE).
