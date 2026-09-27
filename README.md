# Testbench

Test management for testers: test cases, runs and execution, with Jira, notifications, analytics and more to follow.
Architecture and roadmap: [docs/HLD.md](docs/HLD.md).

This is **milestone M1**: sign in, browse and edit test cases (module tree, 1,00,000-row grid, bulk edits,
versions), create runs, and execute them step by step with evidence uploads.

## Run it locally

Needs Node 24, pnpm 11 (via corepack) and Docker Desktop.

```sh
cp .env.example .env
pnpm install
pnpm infra:up             # Postgres, Valkey, Keycloak, S3 (SeaweedFS), Mailpit
pnpm db:migrate
pnpm seed --size dev      # 1,00,000 cases; use --size demo for 1,000
pnpm dev                  # web on http://localhost:3000, API on http://localhost:4000
```

```mermaid
flowchart LR
  B[Browser] -->|cookies| W[Next.js :3000]
  W -->|/api/core/* + bearer token| A[core-api :4000]
  W <-->|OIDC + PKCE| K[Keycloak :8080]
  A --> P[(Postgres :5433)]
  A --> V[(Valkey :6379)]
  B -->|presigned PUT/GET| S[(S3 :9000)]
```

### Accounts

All passwords are `Testbench@123` (local realm only).

| Email | Role |
|---|---|
| anita.desai@paytrail.in | Org Admin |
| rahul.verma@paytrail.in | Project Admin |
| sneha.iyer@paytrail.in | Test Lead |
| aarav.mehta@paytrail.in | Tester (PAY only) |
| aditya.chauhan@paytrail.in | Viewer |

Keycloak admin console: http://localhost:8080 (admin / admin).

## Tests

```sh
pnpm test        # unit tests everywhere, plus API integration tests against the local stack
pnpm test:e2e    # Playwright, signs in through Keycloak; needs `pnpm dev` running
```

The integration tests create their own organisations and users and delete them afterwards, so they never touch seeded data.

## Layout

| Path | What |
|---|---|
| `apps/web` | Next.js app. Screens live in `src/features/*`; design tokens in `src/app/globals.css` come from the Claude Design canvas |
| `deploy/core-api` | The API process: mounts the service modules below (HLD §1.1) |
| `services/iam`, `repository`, `execution` | Service modules: routes, queries, and pure domain logic with unit tests |
| `packages/contracts` | Request schemas (Zod) and response types shared by API and web |
| `packages/platform` | Config, auth, tenant-scoped DB transactions, cache, S3, outbox |
| `db` | SQL migrations and the seed |
| `infra/local` | Docker Compose and Keycloak realm |
| `e2e` | Playwright tests |

## Notes

- Postgres is on port **5433** because 5432 is often used by other local projects.
- S3 is **SeaweedFS**: MinIO no longer publishes community images. The app only speaks the S3 API.
- Runs are created synchronously and capped at 5,000 cases per run until the background expander lands (M2).
