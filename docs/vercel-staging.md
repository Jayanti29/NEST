# Vercel staging deployment

NEST uses a single Vercel Express Function for its existing API routes. The React/Vite build is copied to `public/` and served as static assets; the SPA rewrite excludes `/api/**`. Local development keeps SQLite. Vercel refuses to start the app without `DATABASE_URL`, so production requests never fall back to a function-local SQLite file.

## Durable storage

The project is prepared for PostgreSQL through the Vercel Marketplace Neon integration. Its free plan currently lists 100 CU-hours, 1 GB of database storage, up to 2 CU, 10 branches, and a 6-hour instant restore window. Those quotas are suitable for a staging evaluation, not a production reliability commitment; the database can become unavailable when free quotas are exhausted. See [Neon's current Free plan](https://neon.com/blog/neon-free-plan-1-gb-per-project).

The `DATABASE_URL` used by Vercel must be the provider's pooled PostgreSQL connection string. `RING_TOKEN_ENCRYPTION_KEY` must remain stable across deployments because it decrypts stored Ring tokens.

## Prepare a preview

1. Review and accept the Neon Marketplace terms in the signed-in Vercel account.
2. Add Neon using the `free_v3` plan and the `sin1` region. Connect it to Preview only; do not attach this staging database to Production.
3. Set Preview-only `NEST_STAGING_AUTH_USERNAME` and `NEST_STAGING_AUTH_PASSWORD` values. Keep Ring app credentials unset until they have been replaced through Ring's supported process.
4. Migrate the existing local database with `npm run migrate:postgres` under the Preview `DATABASE_URL`. The script reads `server/nest.sqlite` read-only, copies records idempotently, and never deletes the source file.
5. Build with `npm run build`, then deploy a Preview with `vercel deploy`.
6. Verify `/`, `/api/health`, `/api/ring/health`, and authenticated application APIs on the returned HTTPS preview hostname before configuring Ring Staging URLs.

## Runtime environment variables

Required for a private Preview:

- `DATABASE_URL`
- `NEST_STAGING_AUTH_USERNAME`
- `NEST_STAGING_AUTH_PASSWORD`

Ring linking remains `not_configured` until these are securely provisioned after credential replacement:

- `RING_CLIENT_ID`
- `RING_CLIENT_SECRET`
- `RING_WEBHOOK_HMAC_KEY`
- `RING_TOKEN_ENCRYPTION_KEY`
- `RING_PARTNER_ACCOUNT_IDENTIFIER`
- `RING_LINK_PASSWORD`

Optional existing settings: `NEST_SIMULATOR`, `NEST_AI_PROVIDER`, and `NEST_CAREGIVER_PASSWORD`.
