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

The Ring Console's one-way (Ring-driven) account-linking mode uses Account Link URL, Default Redirect URL, Token Exchange URL, and Webhook URL fields. Once a publicly reachable HTTPS host exists, register `/api/ring/link`, `/api/ring/oauth/token-exchange`, and `/api/ring/webhook` on that host in **staging** first. The token exchange endpoint accepts Ring's JSON authorization-code request, immediately exchanges the one-time code and looks up `/v1/users/me`, then stores the account's tokens as encrypted and unclaimed. The link page requires the configured NEST identifier/password, checks the 10-minute HMAC-SHA256 nonce, and completes Ring's POST then PATCH integration lifecycle. Ring webhook signatures are checked against the raw body; duplicate webhook request IDs are ignored, and integration removal deletes stored tokens. Use the URLs below only after verifying NEST's app is configured for this one-way flow. Production settings remain separate.

The Ring playground shows Connected only after an authenticated Ring API request succeeds. Stored tokens refresh on demand before expiry; refresh token rotation is persisted with a SQLite compare-and-swap lease so concurrent requests cannot store stale credentials. Invalid grants require reauthorization. A legacy `RING_ACCESS_TOKEN` remains supported for temporary, server-side read-only testing, but it does not enable persistent account linking.

## HTTPS staging host

`render.yaml` prepares a single Render Node web service for staging. It builds the client and server from the repository root, serves the client from Express, binds to Render's `PORT` on `0.0.0.0`, and checks `/api/health`. Render terminates public TLS. The SQLite database is directed to `/var/data/nest.sqlite` on a 1 GB persistent disk; keep the service at one instance because the SQLite file and Render disk are single-instance. Render disks are available only on paid services, so review the current plan and disk charge in Render before creating anything. No service has been created by this repository change.

In Render, connect this repository as a Blueprint and review its proposed service before applying it. Enter the values prompted for `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, `RING_WEBHOOK_HMAC_KEY`, `RING_TOKEN_ENCRYPTION_KEY`, `RING_PARTNER_ACCOUNT_IDENTIFIER`, `RING_LINK_PASSWORD`, `NEST_STAGING_AUTH_USERNAME`, and `NEST_STAGING_AUTH_PASSWORD` in Render's secret environment-variable UI. Do not add these to Git or a frontend `VITE_` variable. The encryption key must be a stable base64-encoded 32-byte key; changing it makes previously stored encrypted tokens unreadable. The username and password protect the NEST UI and data APIs with HTTP Basic Auth for staging. Ring's link page has its own configured account/password check, token exchange accepts Ring's one-time authorization code, the webhook requires a valid HMAC signature, and `/api/health` is public for the host health probe. This is a staging gate, not multi-user production authorization.

Once Render assigns the service hostname, use the same HTTPS origin in the Ring Developer Console's staging fields:

| Ring field | URL |
| --- | --- |
| Account Link URL | `https://<render-service>.onrender.com/api/ring/link` |
| Default Redirect URL | `https://<render-service>.onrender.com/` |
| Token Exchange URL | `https://<render-service>.onrender.com/api/ring/oauth/token-exchange` |
| Webhook URL | `https://<render-service>.onrender.com/api/ring/webhook` |

Replace `<render-service>` with the hostname Render actually assigns; these URLs cannot be made literal until the host exists. Deploy the staging branch/service only after reviewing the Blueprint and its paid compute + disk charges. Then check `/api/health`, `/`, and each callback URL (the callbacks may return validation errors to a plain browser GET); complete Ring's staging account-link test and confirm an authenticated Ring API call in the playground. The OAuth flow also depends on the Ring app's one-way account-linking mode and the matching staging URLs in the Developer Console. Production settings are not part of this setup.

The VS Code workspace includes the Ring Appstore Knowledge MCP server in `.vscode/settings.json` for GitHub Copilot Chat. It searches and retrieves Ring developer documentation; it does not access Ring accounts, devices, or tokens. The same server can be configured in other supported coding assistants by following [Ring's setup guide](https://developer.amazon.com/docs/ring/ring-mcp.html).

The AWS Builder mini-challenge is optional. No AWS credentials were supplied, and this build does not call Bedrock. Do not describe AWS as an integration in a submission unless Bedrock is configured and demonstrated.

## Data, safety and privacy

The seeded people are fictional. Acknowledging a reminder records a response only; it does not confirm that an activity happened. A missing device report is shown as **No data received**. NEST does not assess whether anyone is safe, diagnose, provide medical advice, send caregiver notifications, capture audio or video, or replace human care or emergency services. Reset demo clears recorded responses, requests, check-ins and events for the local demo database.

This is a hackathon prototype, not a production account system. The optional staging HTTP Basic Auth gate is a shared staging password, not a user authentication or caregiver authorization system. Keep using fictional demo data and do not treat it as production protection for personal or health information. The app's caregiver view is for fictional demo data only.

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

The Ring Playground proxies the documented read endpoints for users, device list/detail, status, capabilities, location, configurations and event history. These requests go from Express to `https://api.amazonvision.com`; the browser never receives Ring tokens. The UI distinguishes missing configuration, authorization required, refresh failure, reauthorization required, and a connection verified by a successful API response. It never substitutes simulated events for a failed Ring request. On the staging deployment, set both staging auth variables before sharing the hostname; the app and Ring data APIs require HTTP Basic Auth while the validated Ring callbacks remain reachable.

## Hackathon submission checklist

The code repository and running app are only part of a submission. Record a short demo video, write the project description and product feedback, choose the track, and submit through Devpost. Be accurate about simulator-only events and any integrations that have not been activated.

## License

MIT. See [LICENSE](LICENSE).
