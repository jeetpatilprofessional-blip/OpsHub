# OpsHub One

One operations hub for multiple, independently configured sites. The prototype includes three seeded sites, a global sign-in, site-specific themes and navigation, inventory and request workflows, a typed React Flow builder, versioned releases, PostgreSQL row-level security, and Excel reports.

## Run the demo

```powershell
npm install
npm run dev
```

Open the Vite URL shown in the terminal (normally `http://localhost:5173`). The API runs on port `4000`. Without `DATABASE_URL`, it uses the seeded in-memory demo store; without `MINIMOTH_API_KEY`, password login works offline. Demo writes last until the API process stops. `server/seed-data.json` is the offline backup and can be reseeded by restarting the API.

Sign in with:

| Role | Email | Password |
| --- | --- | --- |
| Admin | `admin@opshub.local` | `Demo2026!` |
| Manager | `manager@opshub.local` | `Demo2026!` |
| Member | `sam@opshub.local` | `Demo2026!` |
| Central Stores | `stores@opshub.local` | `Demo2026!` |
| Service Centre | `service@opshub.local` | `Demo2026!` |
| Distribution | `distribution@opshub.local` | `Demo2026!` |

## PostgreSQL mode

Docker is included for a local PostgreSQL 16 instance. Copy `.env.example` to `.env`, then start the database and app:

```powershell
docker compose up -d postgres
Copy-Item .env.example .env
npm run dev
```

The API applies `server/schema.sql` and idempotently seeds the demo tenants on startup. The schema forces row-level security on `sites`, `site_memberships`, `site_records`, and `site_releases`. Every tenant request checks membership, opens a transaction, and sets transaction-local `opshub.site_id` before querying data. Do not use the demo JWT secret or demo passwords outside a local prototype; set a unique `JWT_SECRET` and `DEMO_PASSWORD` for a non-demo environment.

## MiniMoth phone sign-in

OpsHub uses the official [`@minimoth/sdk-node`](https://minimoth.dev/docs/sdk-nodejs) for optional OTP delivery and verification. Set `MINIMOTH_API_KEY` in the server-only `.env` file; never add it to Vite variables, source, or browser storage. Site Managers/Admins can enroll a member's E.164 phone number from Team & access. The login screen exposes Phone OTP only when the server has the key configured. After MiniMoth verifies the OTP, OpsHub maps the enrolled phone to its local user and issues its own JWT; site membership and roles remain enforced by OpsHub. Password login stays available as a fallback.

The integration is covered with a mocked provider in `tests/api.test.js`; live delivery has not been tested here. The previously shared test key should be regenerated in MiniMoth before configuring it locally.

## Demo path

1. Sign in as the Admin and compare the Central Stores, Service Centre, and Distribution site cards.
2. Open Central Stores and choose **Store requests** to request a product for replenishment. The request is matched to Distribution stock and appears in its **Store requests** queue.
3. Sign in to Distribution as a Manager and approve the request. The request, approval record, dispatch assignment, and Distribution stock decrement commit as one operation. Central Stores can see the updated request status.
4. Switch to Service Centre to see its separate theme, service queue, and repair workflow. Link repair records to requests and track them through pickup and completion.
5. Open Site builder, choose a preset, add or configure modules, and connect only matching port types. Publish, then restore a previous release from history.
6. Open Reports & Excel to export a site-scoped workbook. The API also accepts an `Inventory` worksheet upload with `SKU`, `Item`, and `Quantity` columns.

## Commands

```powershell
npm test       # API behavior, RBAC, isolation, workflow, release, and export checks
npm run build  # TypeScript check and production frontend bundle
npm run seed   # Seed PostgreSQL demo tenants (requires DATABASE_URL)
```

## Project map

- `src/domain.ts` — typed site model, approved module catalogue, presets, API client.
- `src/App.tsx` and `src/App.css` — hub, site renderer, builder, and responsive UI.
- `server/index.js` — JWT/bcrypt auth, optional MiniMoth OTP, scoped API, workflow transactions, Excel handling.
- `server/schema.sql` — PostgreSQL schema and forced tenant RLS policies.
- `server/seed-data.json` — portable seeded demo backup for three distinct sites.
- `tests/api.test.js` — focused API regression checks.
- `docs/architecture.md` and `docs/module-registry.md` — architecture, data model, API, and module mapping.

This is a working prototype, not a production deployment. The no-database demo adapter is intentionally ephemeral. PostgreSQL persistence is available through the included schema and Compose service; production hardening still requires deployment secrets, rate limiting, audit retention, migrations, and operational backups.
