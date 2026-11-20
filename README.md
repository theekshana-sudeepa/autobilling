<div align="center">

# AutoBilling

**Idempotent, Self-Hosted Recurring Billing, PDF Invoicing & Payment Chasing Engine**  
*Add a client once. Automate invoice generation, branded PDF delivery, receivables tracking, and overdue escalation forever.*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7_Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev/)
[![TanStack Query](https://img.shields.io/badge/TanStack_Query-v5-FF4154?style=for-the-badge&logo=reactquery&logoColor=white)](https://tanstack.com/query)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4.0-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![Node.js](https://img.shields.io/badge/Node.js-22_LTS-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.21-000000?style=for-the-badge&logo=express&logoColor=white)](https://expressjs.com/)
[![Prisma](https://img.shields.io/badge/Prisma-6-2D3748?style=for-the-badge&logo=prisma&logoColor=white)](https://www.prisma.io/)
[![MySQL](https://img.shields.io/badge/MySQL-8.0-4479A1?style=for-the-badge&logo=mysql&logoColor=white)](https://www.mysql.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-10B981?style=for-the-badge)](./LICENSE)

</div>

---

## Overview

**AutoBilling** is a production-hardened, full-stack recurring billing and accounts-receivable automation platform engineered for agencies, SaaS teams, and B2B service providers. Rather than relying on brittle application-level flags, every critical financial invariant—from invoice period uniqueness to email deduplication and distributed job locking—is enforced directly at the database layer.

It ships as a strict-TypeScript monorepo with a **Node 22 / Express + Prisma / MySQL 8** backend (`server/`), a **React 19 + TanStack Query v5 + Vite 6 + Tailwind CSS v4** admin SPA (`web/`), native **`pdf-lib` + QR code** invoice generation, dual-provider email failover (**Resend → SMTP**), and turnkey **AWS EC2** and **Oracle Cloud** deployment automation (`deploy/`).

---

## Product Showcase

### Executive Receivables Dashboard
*Real-time MRR/ARR KPIs, 12-month Billed vs. Collected revenue curve, receivables ageing buckets (`current`, `1-30`, `31-60`, `61-90`, `90+`), top-client rankings, and live automation activity stream.*

<p align="center">
  <img src="./docs/screenshots/dashboard.png" alt="AutoBilling Executive Receivables Dashboard" width="100%" />
</p>

### Invoices & Receivables Ledger
*High-density tabular ledger with summary KPI strip, debounced search, status filter chips, `tabular-nums` currency alignment, due-status indicators, and one-click authenticated PDF download.*

<p align="center">
  <img src="./docs/screenshots/invoices.png" alt="AutoBilling Invoices Management UI" width="100%" />
</p>

### Invoice Detail, Reminder Timeline & Native Branded PDF / QR Engine
*Side-by-side view of the live Invoice Detail SPA (automated reminder schedule, email delivery audit log, payment recording) and the native A4 invoice rendered directly via `pdf-lib` + `qrcode` in ~25ms.*

<p align="center">
  <img src="./docs/screenshots/invoice-pdf-preview.png" alt="AutoBilling Invoice Detail and Branded PDF QR Preview" width="100%" />
</p>

---

## System Architecture

```mermaid
flowchart LR
    subgraph ClientTier["Client & Edge Layer"]
        Browser["React 19 Admin SPA<br/>Vite 6 · TanStack Query · Tailwind v4"]
        Nginx["Nginx Reverse Proxy<br/>TLS 1.3 · Static SPA · Same-Origin API"]
    end

    subgraph AppTier["Express API & Billing Engine"]
        API["REST API v1<br/>Helmet · CORS · Rate Limit · Zod"]
        Auth["Zero-LocalStorage Auth<br/>In-Memory JWT · Rotating Refresh Cookie"]
        Scheduler["Daily Billing Scheduler<br/>Distributed DB Lock · node-cron"]
        PDF["Native PDF Engine<br/>pdf-lib · QR Codes · Protected Storage"]
        Mailer["Email Delivery Engine<br/>Resend Primary · SMTP Failover · Retry Queue"]
    end

    subgraph DataTier["Persistence & External Services"]
        MySQL["MySQL 8 Ledger<br/>Prisma ORM · DECIMAL 12,2 · Unique Guards"]
        Storage["Authenticated Storage<br/>Invoice PDFs · Brand Logos"]
        Providers["External Mail Providers<br/>Resend API / Custom SMTP"]
    end

    Browser -->|HTTPS Requests| Nginx
    Nginx -->|Proxy API and Storage| API
    API -->|Verify Access Token| Auth
    API -->|Read and Write Ledger| MySQL
    API -->|Stream Protected PDF| Storage
    Scheduler -->|Acquire Distributed Lock| MySQL
    Scheduler -->|Render Invoice PDF| PDF
    PDF -->|Persist PDF Artifact| Storage
    Scheduler -->|Queue Deduplicated Mail| Mailer
    Mailer -->|Deliver With Failover| Providers
    Mailer -->|Update Delivery Status| MySQL
```

---

## Idempotent Billing Cycle, Zero-LocalStorage Auth & Dual-Provider Failover

Every security boundary and financial side effect is designed to survive concurrency, process restarts, and upstream provider outages without leaking credentials or creating duplicate charges or emails.

```mermaid
sequenceDiagram
    participant SPA as React 19 SPA
    participant API as Express API & Auth
    participant Cron as Daily Scheduler
    participant DB as MySQL 8 Ledger
    participant PDF as Native PDF Engine
    participant Resend as Resend Primary
    participant SMTP as SMTP Failover

    Note over SPA,DB: Flow 1 - Zero-LocalStorage Auth & Single-Flight Refresh Mutex
    SPA->>API: Concurrent API requests with expired in-memory JWT
    API-->>SPA: 401 Unauthorized
    SPA->>API: Single coalesced POST /api/v1/auth/refresh with HttpOnly cookie
    API->>DB: Lookup SHA-256 refresh tokenHash & verify familyId
    alt Revoked token reused
        API->>DB: Revoke entire refresh token family & log security audit
        API-->>SPA: 401 Session invalidated
    else Valid active token
        API->>DB: Rotate refresh token in same familyId
        API-->>SPA: New HttpOnly cookie & short-lived access JWT in memory
        SPA->>API: Replay queued requests once with skipRetry guard
    end

    Note over Cron,SMTP: Flow 2 - Strictly Ordered Idempotent Billing & Dual-Provider Mail Failover
    Cron->>DB: Acquire distributed lock via unique job_runs jobName + runKey
    DB-->>Cron: Lock granted or 30m stale takeover
    Cron->>DB: Stage 1 - Mark past-due unpaid invoices OVERDUE
    Cron->>DB: Stage 2 - Insert invoice guarded by unique subscriptionId + periodStart
    Cron->>PDF: Render A4 invoice with dynamic layout & QR code
    PDF-->>DB: Store PDF path & SHA-256 integrity hash
    Cron->>DB: Stage 3 - Insert email_logs row guarded by unique dedupeKey
    Cron->>Resend: Dispatch transactional invoice or reminder email
    alt Resend succeeds
        Resend-->>DB: Mark email_logs SENT with providerId
    else Transient Resend error or 5xx outage
        Resend-->>Cron: Retryable delivery error
        Cron->>DB: Decrypt AES-256-GCM SMTP credentials from settings
        Cron->>SMTP: Automatic failover dispatch via pooled SMTP transport
        alt SMTP failover succeeds
            SMTP-->>DB: Mark email_logs SENT via smtp failover
        else Both providers unavailable
            SMTP-->>DB: Schedule exponential backoff retry every 15m
        end
    else Permanent 4xx recipient rejection
        Resend-->>DB: Mark BOUNCED or FAILED with retryable false
    end
```

---

## Frontend Engineering Architecture (`web/`)

The admin interface is engineered for financial precision, zero-flicker state transitions, and strict runtime contract safety:

- **TanStack Query v5 Cache Strategy & Invalidation (`src/lib/queryClient.ts`):**
  - Centralized typed query-key factory (`qk`) across dashboard, clients, subscriptions, invoices, invoice timelines, payments, email logs, and settings.
  - Configured with `staleTime: 30_000` and `refetchOnWindowFocus: true` so operators never view a stale "Unpaid" status after a settlement, while avoiding redundant fetches during rapid tab navigation.
  - Paginated tables use `placeholderData: (prev) => prev` with subtle `aria-busy` opacity transitions for zero-jank page changes.
  - Custom retry policy short-circuits all `4xx` responses (`error instanceof ApiError && error.status < 500`) so auth or validation errors fail fast while transient `5xx` errors retry twice.
  - Mutations (`recordPayment`, `voidInvoice`, `sendInvoice`, `runBilling`) coordinate multi-key invalidation across detail views, reminder timelines, filtered tables, and executive KPIs.
- **Strict TypeScript & Zod Contract Alignment (`tsconfig.json`, `eslint.config.js`, `src/types/api.ts`):**
  - Compiled with `strict: true`, `noUncheckedIndexedAccess: true`, `noUnusedLocals: true`, and `noUnusedParameters: true`, backed by ESLint v9 flat config (`--max-warnings 0`, zero `any`, React 19 Compiler & Hooks rules).
  - Form workflows use **React Hook Form + Zod (`@hookform/resolvers/zod`)** with `useWatch` (React Compiler-safe) and direct mapping of backend `ApiError.fieldErrors` into inline field validation messages.
- **Zero-LocalStorage Auth & Single-Flight Refresh Mutex (`src/lib/api.ts`, `src/features/auth/AuthProvider.tsx`):**
  - Access JWTs live exclusively in module closure memory (never `localStorage` or `sessionStorage`), eliminating token exfiltration via XSS.
  - Refresh tokens live in `HttpOnly`, same-origin cookies exchanged on boot to re-hydrate the session.
  - A module-level `refreshPromise` mutex coalesces parallel `401` failures into exactly one `/auth/refresh` call, with an explicit `skipRetry` guard on both `request()` and `requestPaged()` to prevent retry loops.
- **Explicit Loading, Empty & Error UI States (`src/components/common/states.tsx`, `src/styles/globals.css`):**
  - Every data-driven screen explicitly renders layout-matched skeletons (`TableSkeleton`, `CardSkeleton`), contextual `EmptyState` views with next-step CTAs, and accessible `ErrorState` banners (`role="alert"`) with one-click retry.
  - Built on **Tailwind CSS v4** semantic HSL design tokens (`@theme inline`) with first-class Light/Dark parity, `tabular-nums` financial typography, reduced-motion accessibility, and power-user keyboard navigation (`⌘K`, `g+d`, `g+c`, `g+i`, `g+s`, `g+p`).

---

## Core Data Model

All monetary values use `DECIMAL(12,2)` (never IEEE-754 floats). Financial documents (`invoices`, `payments`) are immutable ledgers—voided or reversed rather than deleted—with full `before`/`after` JSON audit trails.

```mermaid
erDiagram
    USERS ||--o{ REFRESH_TOKENS : "rotates family"
    USERS ||--o{ AUDIT_LOGS : "records actions"
    USERS ||--o{ PAYMENTS : "records payments"
    CLIENTS ||--o{ SUBSCRIPTIONS : "subscribes to"
    CLIENTS ||--o{ INVOICES : "billed via"
    CLIENTS ||--o{ EMAIL_LOGS : "receives"
    SUBSCRIPTIONS ||--o{ INVOICES : "generates"
    INVOICES ||--o{ INVOICE_ITEMS : "contains"
    INVOICES ||--o{ PAYMENTS : "settled by"
    INVOICES ||--o{ EMAIL_LOGS : "triggers"

    USERS {
        string id PK
        string email "Unique login email"
        string role "ADMIN or STAFF"
        int tokenVersion "Global revocation counter"
    }

    REFRESH_TOKENS {
        string id PK
        string userId FK
        string tokenHash "Unique SHA-256 token hash"
        string familyId "Reuse revokes entire family"
        datetime expiresAt
    }

    CLIENTS {
        string id PK
        string code "Unique CLI-0001 code"
        string companyName
        string email
        string status "ACTIVE or INACTIVE"
    }

    SUBSCRIPTIONS {
        string id PK
        string clientId FK
        string serviceName
        decimal amount "DECIMAL 12,2"
        string billingCycle "MONTHLY QUARTERLY YEARLY"
        int dueDay "1 to 28 safe every month"
        string status "ACTIVE PAUSED CANCELLED"
    }

    INVOICES {
        string id PK
        string invoiceNumber "Unique INV-YYYY-NNNNN"
        string clientId FK
        string subscriptionId FK
        date periodStart "Unique with subscriptionId"
        date dueDate
        decimal total "DECIMAL 12,2"
        decimal amountPaid "DECIMAL 12,2"
        string status "DRAFT SENT PARTIALLY_PAID PAID OVERDUE VOID"
    }

    INVOICE_ITEMS {
        string id PK
        string invoiceId FK
        string description
        decimal quantity
        decimal unitPrice
        decimal lineTotal
    }

    PAYMENTS {
        string id PK
        string invoiceId FK
        string recordedById FK
        decimal amount
        string method "BANK_TRANSFER CASH CARD CHEQUE ONLINE OTHER"
        datetime paidAt
        datetime voidedAt
    }

    EMAIL_LOGS {
        string id PK
        string invoiceId FK
        string clientId FK
        string type "INVOICE_CREATED REMINDER PAYMENT_RECEIVED"
        string status "QUEUED SENT FAILED BOUNCED CANCELLED"
        string dedupeKey "Unique exact-once delivery guard"
        int attempts
    }

    AUDIT_LOGS {
        string id PK
        string actorId FK
        string action
        string entity
        string entityId
    }
```

---

## Key Backend & Integration Engineering Highlights

| Domain | Architecture & Guarantees |
| :--- | :--- |
| **Database-Enforced Idempotency** | Unique constraints on `invoices(subscriptionId, periodStart)`, `email_logs(dedupeKey)`, and `job_runs(jobName, runKey)` make invoice generation, reminders, and cron retries 100% safe to execute repeatedly without duplicates. |
| **Financial Ledger Integrity** | Strict `DECIMAL(12,2)` arithmetic, transactional invoice numbering (`number_sequences`), derived invoice status recomputation, void/reversal workflows instead of destructive deletes, and structured `AuditLog` snapshots (`before`/`after` JSON diffs). |
| **Zero-LocalStorage Security** | Short-lived JWT access tokens live strictly in memory. Refresh tokens use `httpOnly` same-origin cookies with token rotation families—reusing a revoked token invalidates the entire family and logs an audit event. |
| **Encrypted Secrets at Rest** | Runtime SMTP credentials stored in `settings` are encrypted using **AES-256-GCM** (`ENCRYPTION_KEY`) and never returned to the browser (`smtpPasswordSet: boolean`). |
| **Native Branded PDF Engine** | Renders crisp A4 invoices via `pdf-lib` in ~25ms with flat memory overhead (no headless Chrome per invoice), dynamic column/payment-box sizing, company logo embedding, QR code support, SHA-256 caching, and authenticated `/storage` file delivery. |
| **Resilient Dual-Provider Email** | Resend API primary transport with automatic SMTP failover on both thrown network failures and retryable API errors, console dry-run mode for safe pre-launch testing, Outlook/Gmail/Apple Mail table-layout templates, and exponential backoff retry scheduling every 15 minutes. |
| **Observability & Analytics** | Executive dashboard with MRR/ARR snapshots, cash-collected vs. billed trends, receivables ageing buckets, top-client rankings, and structured Pino JSON logging with sensitive-field redaction and `X-Request-Id` tracing. |
| **Dual-Cloud IaC Automation** | Idempotent provisioning, zero-downtime migration-before-restart releases, fail2ban, TLS certbot setup, and keyless offsite backups for both **AWS EC2 + S3 IAM Role** and **Oracle Cloud Always Free + OCI Instance Principal**. |

---

## Repository Structure

```text
autobilling/
├── deploy/
│   ├── aws/                     # AWS EC2 bootstrap, deploy, nginx & S3 IAM backup scripts
│   └── oracle/                  # Oracle Cloud ARM bootstrap, deploy, nginx & OCI backup scripts
├── docs/
│   ├── screenshots/             # Live captured SPA & native PDF/QR UI screenshots
│   ├── API.md                   # Complete REST API v1 contract & payload reference
│   ├── DEPLOY-AWS.md            # AWS Free Tier EC2 + S3 production guide
│   ├── DEPLOY-ORACLE.md         # Oracle Cloud Always Free production guide
│   ├── FIRST-CLIENT.md          # Safe onboarding checklist for your first billing client
│   ├── GOING-LIVE.md            # End-to-end local -> DNS/email -> VPS launch guide
│   └── PRELAUNCH.md             # Dry-run verification & pre-flight checklist
├── server/
│   ├── prisma/
│   │   ├── migrations/          # Versioned MySQL 8 SQL migrations
│   │   ├── schema.prisma        # Relational ledger & idempotency schema
│   │   └── seed.ts              # Idempotent admin, staff, settings & optional demo seed
│   ├── src/
│   │   ├── config/              # Fail-fast Zod environment validation
│   │   ├── jobs/                # Distributed lock, daily pipeline, retries & CLI runner
│   │   ├── lib/                 # AES-256-GCM crypto, money math, dates, numbering & tests
│   │   ├── middleware/          # Auth, RBAC, Zod validation, audit trail, rate limiting
│   │   ├── modules/             # auth, clients, subscriptions, invoices, payments, dashboard, emaillogs, settings
│   │   ├── scripts/             # CLI client onboarding utility (addClient.ts)
│   │   ├── services/            # Native PDF invoice renderer & Resend/SMTP email engine
│   │   ├── app.ts               # Hardened Express application factory
│   │   └── server.ts            # Graceful HTTP & scheduler lifecycle bootstrap
│   ├── Dockerfile               # Production Node 22 container image
│   ├── ecosystem.config.cjs     # PM2 production process definition
│   └── eslint.config.js         # Strict ESLint v9 flat config (TypeScript)
└── web/
    ├── public/                  # SVG assets
    ├── src/
    │   ├── components/          # Reusable UI primitives, layout shell, DataTable, Modal, States
    │   ├── features/            # AuthProvider (in-memory token lifecycle) & client hooks
    │   ├── lib/                 # Single-flight API client, currency formatters, React Query keys
    │   ├── pages/               # Dashboard, Clients, Subscriptions, Invoices, Payments, Email Logs, Settings
    │   ├── styles/              # Light/dark design tokens (Tailwind CSS v4)
    │   └── types/               # End-to-end TypeScript API contracts
    └── eslint.config.js         # Strict ESLint v9 flat config (TS + React 19 Hooks/Refresh)
```

---

## Getting Started

### Prerequisites

- **Node.js** `>= 20.9.0` (Node 22 LTS recommended)
- **MySQL 8.0+**
- **npm** `>= 10`

### 1. Clone & Create the Database

```bash
git clone https://github.com/theekshana-sudeepa/autobilling.git
cd autobilling

mysql -u root -e "CREATE DATABASE autobilling CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 2. Configure & Start the Backend (`server/`)

```bash
cd server
cp .env.example .env
```

Generate cryptographically secure secrets and paste them into `server/.env`:

```bash
node -e "for (const k of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','ENCRYPTION_KEY']) console.log(k+'='+require('crypto').randomBytes(32).toString('hex'))"
```

For local testing without sending real emails, set `EMAIL_PROVIDER=console` in `server/.env`. Then install, migrate, seed, and start:

```bash
npm install
npx prisma generate
npx prisma migrate dev
SEED_DEMO=true npm run seed
npm run dev
```

> **Default seeded credentials** (change immediately in any non-local environment):  
> Admin: `admin@example.com` / `ChangeMe123!` (or set `SEED_ADMIN_PASSWORD`)  
> Staff: `staff@example.com` / `ChangeMe123!`

### 3. Configure & Start the Frontend (`web/`)

Open a second terminal:

```bash
cd web
cp .env.example .env
npm install
npm run dev
```

Visit `http://localhost:5173` — the Vite dev proxy keeps `/api` and `/storage` first-party so `httpOnly` refresh cookies behave identically to production.

### 4. Quality Gates, Unit Tests & Billing CLI

```bash
# Frontend strict TypeScript, ESLint (--max-warnings 0), and Vite production build
cd web && npm run typecheck && npm run lint && npm run build

# Backend strict TypeScript, ESLint (--max-warnings 0), build, and unit tests
cd server && npm run typecheck && npm run lint && npm run build && npm test

# Trigger billing jobs manually via CLI
cd server
npm run jobs:run -- generate
npm run jobs:run -- pipeline
npm run jobs:run -- retry
```

---

## Documentation & Production Deployment

- **[API Reference](./docs/API.md)** — Full endpoint catalog, authentication flows, and payload schemas
- **[Going Live Guide](./docs/GOING-LIVE.md)** — Local testing → Resend DNS verification → single-VPS hosting
- **[AWS EC2 Deployment](./docs/DEPLOY-AWS.md)** — 1 GB Free Tier swap/MySQL tuning, Nginx TLS, and keyless S3 IAM backups
- **[Oracle Cloud Deployment](./docs/DEPLOY-ORACLE.md)** — Always Free ARM provisioning, iptables hardening, and OCI Object Storage backups
- **[Pre-Launch Checklist](./docs/PRELAUNCH.md)** — End-to-end dry run and production verification gates

---

## License

Distributed under the **MIT License**. See [`LICENSE`](./LICENSE) for details.

---

<div align="center">

**Engineered by [Theekshana Sudeepa](https://github.com/theekshana-sudeepa)**  
[LinkedIn](https://www.linkedin.com/in/theekshana-sudeepa/) · [GitHub](https://github.com/theekshana-sudeepa) · [LexoraTech](https://lexoratech.com)

</div>
