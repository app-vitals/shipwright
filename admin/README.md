# Shipwright Admin Service

The admin service provides a web UI and CRUD API for managing Shipwright agents — env vars, cron jobs, tokens, tools, and plugins. It also exposes the runtime API used by deployed agents to fetch their configuration.

The HTTP server is implemented in `agent/src/run-agent.ts` (`startServer()`), which composes the admin UI, admin CRUD API, and agent runtime API into a single Hono app running on port 3000.

## Running Locally

```bash
# From repo root — install all workspace deps
bun install

# Export required env vars (see Environment Variables table below)
export DATABASE_URL=postgresql://...
export SHIPWRIGHT_SESSION_SECRET=...
# ... (remaining vars)

# Run the admin server
bun run agent/src/run-agent.ts
```

The service listens on `http://localhost:3000` by default. Visit `/admin` for the UI.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string for the admin Prisma schema |
| `SHIPWRIGHT_SESSION_SECRET` | Yes | JWT cookie secret for admin UI sessions |
| `GOOGLE_CLIENT_ID` | Yes | Google OAuth 2.0 client ID for admin UI login |
| `GOOGLE_CLIENT_SECRET` | Yes | Google OAuth 2.0 client secret |
| `ADMIN_ALLOWED_EMAILS` | Yes | Comma-separated list of emails permitted to log in |
| `APP_BASE_URL` | Yes | Public base URL used for OAuth redirect (defaults to `http://localhost:3000`) |
| `SHIPWRIGHT_INTERNAL_API_KEY` | Yes | Bearer token for the agent runtime API (`/agents/*`) |
| `SHIPWRIGHT_ENCRYPTION_KEY` | Recommended | 64-char hex key for AES-256-GCM encryption of stored secrets |
| `PORT` | No | HTTP server port (defaults to `3000`) |

## Database

The admin service uses its own PostgreSQL database. Run migrations before starting:

```bash
export DATABASE_URL=postgres://...
cd admin && bunx prisma migrate deploy --schema=prisma/schema.prisma
```

## Building the Docker Image

Build from the repo root (the Dockerfile uses the full monorepo context):

```bash
docker build -f admin/Dockerfile -t shipwright-admin .
```

Run the image:

```bash
docker run \
  -e DATABASE_URL=postgres://... \
  -e SHIPWRIGHT_SESSION_SECRET=... \
  -e GOOGLE_CLIENT_ID=... \
  -e GOOGLE_CLIENT_SECRET=... \
  -e ADMIN_ALLOWED_EMAILS=admin@example.com \
  -e APP_BASE_URL=https://admin.example.com \
  -e SHIPWRIGHT_INTERNAL_API_KEY=... \
  -p 3000:3000 \
  shipwright-admin
```

## Deployment

A GKE Deployment + Service manifest is provided at [`admin/deploy/deployment.yaml`](./deploy/deployment.yaml).

It expects a Kubernetes Secret named `shipwright-admin-secret` containing all required env vars. See the comments at the top of the manifest for setup instructions.
