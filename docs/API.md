# AutoBilling REST API — v1

Base URL: `{API_URL}/api/v1`

## Conventions

Every response uses the same envelope.

```jsonc
// success
{ "ok": true, "data": { }, "meta": { "page": 1, "pageSize": 20, "total": 84, "totalPages": 5 } }

// failure
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "field": "dueDay", "message": "Due day must be 1–28", "code": "too_big" }]
  },
  "requestId": "8f0c…"
}
```

| Status | Code | Meaning |
|--------|------|---------|
| 400 | `BAD_REQUEST` | Malformed request the schema could not reject |
| 401 | `UNAUTHORIZED` | Missing / expired access token → call `/auth/refresh` |
| 403 | `FORBIDDEN` | Authenticated but wrong role |
| 404 | `NOT_FOUND` | No such record |
| 409 | `CONFLICT` / `DUPLICATE` | State conflict (unpaid invoices, duplicate email) |
| 422 | `VALIDATION_ERROR` | Zod rejection — `details[]` maps to form fields |
| 429 | `RATE_LIMITED` | Throttled |
| 500 | `INTERNAL_ERROR` | Message is suppressed in production |

**Auth.** `Authorization: Bearer <accessToken>` on everything except
`/auth/login` and `/auth/refresh`. Access tokens live 15 minutes; the refresh
token is an httpOnly, SameSite cookie scoped to `/api/v1/auth`.

**Roles.** `STAFF` can read everything and perform daily operations
(create clients/subscriptions/invoices, record payments, send invoices).
`ADMIN` additionally deletes, voids, requeues emails, manages users and settings.

---

## Auth

### `POST /auth/login` · public · rate limited 8/15min

```jsonc
// request
{ "email": "admin@example.com", "password": "••••••••" }

// 200
{ "ok": true, "data": {
  "accessToken": "eyJhbGciOi…",
  "user": { "id": "clx…", "email": "admin@example.com", "name": "System Administrator", "role": "ADMIN", "isActive": true, "lastLoginAt": "2026-07-30T05:12:00.000Z" }
}}
```

Sets `ab_rt` refresh cookie. Validation: `email` valid email; `password` non-empty.
Failures always return the same generic 401 — no user enumeration.

### `POST /auth/refresh` · public
Body optional (`{ "refreshToken": "…" }`); the cookie is preferred.
Rotates the token. Presenting an already-revoked token revokes the whole family
(theft detection) and returns 401.

### `POST /auth/logout` · public — revokes the presented token, clears the cookie.

### `GET /auth/me` — current user.

### `POST /auth/change-password`
`{ currentPassword, newPassword }` — new password ≥10 chars with upper, lower and
a digit; must differ from the current one. Revokes every session on success.

### `GET|POST /auth/users`, `PATCH|DELETE /auth/users/:id` · ADMIN
Create: `{ email, name, password, role: "ADMIN"|"STAFF" }`.
Delete is a soft delete plus global sign-out.

---

## Clients

### `GET /clients`
Query: `page` (≥1, default 1), `pageSize` (1–100, default 20), `search`,
`status` (`ACTIVE`|`INACTIVE`), `sortBy` (`companyName`|`createdAt`|`code`),
`sortDir` (`asc`|`desc`).

Each row is augmented with `activeSubscriptions`, `invoiceCount` and `mrr`
(billing cycles normalised to a monthly figure).

### `GET /clients/:id`
Returns the client plus `subscriptions[]`, the last 24 `invoices[]` and
`stats: { outstanding, lifetimeValue }`.

### `POST /clients`

```jsonc
{
  "companyName": "Silverline Supermarket",   // required, 2–180
  "contactPerson": "Nuwan Perera",           // ≤120
  "email": "accounts@silverline.lk",         // required, valid email
  "billingEmail": "finance@silverline.lk",   // optional, defaults to email
  "ccEmails": "owner@silverline.lk",         // comma-separated, each validated
  "phone": "+94 77 123 4567",
  "whatsapp": "+94 77 123 4567",
  "addressLine1": "No. 12, Galle Road",
  "city": "Colombo", "country": "Sri Lanka",
  "taxId": "VAT123456", "notes": "Internal only",
  "status": "ACTIVE"
}
```

`code` is assigned server-side (`CLI-0001`). 409 if another live client already
uses that email.

### `PATCH /clients/:id` — same shape, all optional.

### `DELETE /clients/:id` · ADMIN
Soft delete; cancels the client's subscriptions. **409** if any invoice is
`SENT` / `OVERDUE` / `PARTIALLY_PAID`, with the offending `invoiceIds` in
`error.details`.

---

## Subscriptions

### `GET /subscriptions`
Query: `page`, `pageSize`, `clientId`, `status`, `search`.

### `GET /subscriptions/:id`
Includes `client`, the last 12 invoices, and `nextBilling`:
`{ periodStart, periodEnd, dueDate, generateOn, isOverdueToGenerate }`.

### `POST /subscriptions`

```jsonc
{
  "clientId": "clx…",                 // required, cuid
  "serviceName": "POS Pro + Support", // required, 2–180
  "description": "Monthly licence…",
  "amount": 12500,                    // required, > 0
  "taxRate": 0,                       // 0–100 percent
  "currency": "LKR",                  // ISO 4217, 3 chars
  "billingCycle": "MONTHLY",          // MONTHLY | QUARTERLY | YEARLY
  "dueDay": 5,                        // required, 1–28
  "startDate": "2026-08-01",          // required
  "endDate": null,                    // must be after startDate
  "autoSend": true
}
```

`dueDay` is capped at 28 by design — the date then exists in every month, so the
scheduler never has to invent a "31 February" fallback.

### `PATCH /subscriptions/:id`
Price changes apply from the next period; issued invoices are never rewritten.

### `POST /subscriptions/:id/pause` — `{ "paused": true|false }`
### `POST /subscriptions/:id/cancel` — sets `CANCELLED`, `endDate = today`
### `DELETE /subscriptions/:id` · ADMIN — soft delete; invoices are preserved

---

## Invoices

### `GET /invoices`
Query: `page`, `pageSize`, `status`, `clientId`, `subscriptionId`, `search`,
`from`, `to`, `overdueOnly`, `sortBy` (`issueDate`|`dueDate`|`total`|`invoiceNumber`),
`sortDir`.

`meta.summary = { totalAmount, paidAmount, outstanding }` for the current filter.

### `GET /invoices/:id`
Full invoice with `client`, `items[]`, `payments[]`, `emailLogs[]`, `balanceDue`.

### `POST /invoices` — manual / one-off invoice

```jsonc
{
  "clientId": "clx…",
  "items": [{ "description": "POS terminal", "quantity": 2, "unitPrice": 45000, "taxRate": 0 }],
  "issueDate": "2026-07-30",
  "dueDate": "2026-08-15",   // required, ≥ issueDate
  "currency": "LKR",
  "discount": 0,
  "notes": "Hardware purchase"
}
```

### `GET /invoices/:id/pdf`
`application/pdf`, `Content-Disposition: inline`. Served from cache when the
file exists on disk; rebuilt otherwise.

### `POST /invoices/:id/regenerate-pdf` · rate limited
### `POST /invoices/:id/send` — `{ "force": false }`
Emails the invoice with the PDF attached. Without `force`, the dedupe key makes
this a no-op if already sent (`{ "status": "skipped", "reason": "already_sent" }`).

### `POST /invoices/:id/remind`
`{ "type": "REMINDER_BEFORE_7" | "REMINDER_BEFORE_3" | "REMINDER_DUE_TODAY" | "REMINDER_OVERDUE_3" | "REMINDER_OVERDUE_7" | "FINAL_NOTICE" }`

### `POST /invoices/:id/void` · ADMIN — `{ "reason": "…" }` (3–255)
409 if payments exist — void the payments first. Cancels pending reminders.

### `POST /invoices/generate` · ADMIN — `{ "date"?: "2026-08-01", "dryRun": false }`
Runs the generation job on demand. Safe to press twice.

### `GET /invoices/upcoming/preview`
Dry run: what the next job would create, with no writes.

---

## Payments

### `GET /payments`
Query: `page`, `pageSize`, `clientId`, `invoiceId`, `method`, `from`, `to`, `search`.
`meta.totalCollected` sums the filtered set.

### `POST /payments`

```jsonc
{
  "invoiceId": "clx…",
  "amount": 12500,               // > 0, must not exceed the balance (+0.01 tolerance)
  "method": "BANK_TRANSFER",     // BANK_TRANSFER|CASH|CARD|CHEQUE|ONLINE|OTHER
  "reference": "TXN-88213",
  "paidAt": "2026-08-04",        // not in the future
  "notes": "Slip emailed",
  "sendReceipt": true
}
```

Response `{ payment, invoice }` with the recomputed invoice. When the balance
reaches zero: status → `PAID`, **all pending reminders are cancelled**, and a
receipt email is queued.

409 if the invoice is `VOID` or still `DRAFT`.

### `POST /payments/:id/void` · ADMIN — `{ "reason": "…" }`
Reversal, not deletion. The invoice status is recomputed from the remaining
payments, so a voided payment can push an invoice back to `OVERDUE`.

---

## Dashboard

| Route | Returns |
|-------|---------|
| `GET /dashboard` | Everything below in one round trip |
| `GET /dashboard/overview` | Clients, MRR (+ MoM change), invoice counts, money, churn |
| `GET /dashboard/revenue?months=12` | `[{ month, billed, collected, outstanding }]` |
| `GET /dashboard/top-clients?limit=8` | Billed / collected / outstanding per client |
| `GET /dashboard/ageing` | `current`, `1-30`, `31-60`, `61-90`, `90+` buckets |
| `GET /dashboard/activity` | Recent audit events, system actions included |
| `GET /dashboard/upcoming` | Invoices due in the next 30 days |

---

## Email logs

### `GET /email-logs`
Query: `page`, `pageSize`, `status`, `type`, `clientId`, `invoiceId`, `search`,
`from`, `to`. `meta.statusCounts` powers the failure banner.

### `GET /email-logs/:id`
### `POST /email-logs/:id/resend` — mints a manual dedupe key so it actually sends
### `POST /email-logs/:id/requeue` · ADMIN — puts an exhausted email back in the queue
### `GET /email-logs/timeline/:invoiceId`

```jsonc
[{ "offset": -7, "type": "REMINDER_BEFORE_7", "scheduledFor": "2026-07-29",
   "state": "sent", "sentAt": "2026-07-29T02:30:11.000Z" }]
```
`state` ∈ `sent` | `scheduled` | `missed` | `cancelled`.

---

## Settings

### `GET /settings` — never includes `smtpPassword`; exposes `smtpPasswordSet: boolean`
### `PATCH /settings` · ADMIN

Notable validation: `invoicePrefix` matches `^[A-Z0-9-]{2,10}$`;
`reminderOffsets` is 1–8 unique integers in −30…60; `invoiceLeadDays` 0–30;
`finalNoticeDay` 1–90. A non-empty `smtpPassword` is encrypted with AES-256-GCM
before storage; omit the field to keep the existing value.

### `POST /settings/logo` · ADMIN — `{ filename, dataBase64 }`, PNG/JPG/SVG, ≤2 MB
### `POST /settings/test-email` · ADMIN · rate limited — `{ to }`

---

## Health

### `GET /health` · public
`{ status, env, dbLatencyMs, uptimeSec, version }` — includes a real `SELECT 1`,
so it fails when MySQL is unreachable.
