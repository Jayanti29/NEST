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

The project follows the attached NEST Developer Build Specification and uses the Alexa+ simulated-experience path described in the Build, Ship, Shape hackathon resources. The simulator remains available. An optional Ring Playground makes read-only, server-to-server calls to the documented Ring API when `RING_ACCESS_TOKEN` is configured. The bearer token remains in the ignored local `.env` file and is never sent to the browser or written to SQLite. Ring data is fetched only when a user invokes an endpoint; it is not stored in the NEST demo database.

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

The Ring Playground also proxies the documented read endpoints for users, device list/detail, status, capabilities, location, configurations and event history. These requests go from Express to `https://api.amazonvision.com`; the browser never receives `RING_ACCESS_TOKEN`. The temporary token supplied for this task was rejected with HTTP 401. Generate a fresh token in the Ring Developer Portal, update the ignored `.env`, and restart the server before invoking Ring endpoints.

## Hackathon submission checklist

The code repository and running app are only part of a submission. Record a short demo video, write the project description and product feedback, choose the track, and submit through Devpost. Be accurate about simulator-only events and any integrations that have not been activated.

## License

MIT. See [LICENSE](LICENSE).
