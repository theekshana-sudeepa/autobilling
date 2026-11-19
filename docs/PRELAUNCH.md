# Pre-launch checklist

Everything below was run end to end on a clean database before the first real
client existed. Work down it in order; nothing after Stage 3 is reversible.

---

## Run it locally

Three processes. Open three terminals.

```bash
# 1 — MySQL must be running first

# 2 — API on :4000
cd server
cp .env.example .env          # see "Config that matters" below
npm install
npx prisma migrate deploy
npm run seed                  # creates the two admin logins
npm run dev

# 3 — Admin UI on :5173
cd web
cp .env.example .env          # leave VITE_API_URL EMPTY — the vite proxy
npm install                   # keeps cookies first-party, exactly like prod
npm run dev
```

Open <http://localhost:5173> and sign in with `admin@example.com` /
`ChangeMe123!`.

**Change that password before the server is reachable from the internet.**
It is in the seed file, which means it is in your git history.

---

## Config that matters

| Setting | Why it bites |
|---|---|
| `TIMEZONE` | Decides what "today" is for the whole billing engine. Invoice dates are stored in UTC and are timezone-independent; *when the job fires* is not. |
| `STORAGE_DIR` | Where invoice PDFs live. Must survive a redeploy and must be backed up. Do not put it inside the git checkout. |
| `EMAIL_PROVIDER` | Keep it `console` until Stage 3. Emails are rendered, logged and recorded — but never sent. |
| `ENCRYPTION_KEY` | Exactly 64 hex chars. Encrypts the SMTP password at rest. Changing it later makes the stored password unreadable. |
| `CRON_ENABLED` | `true` in production, `false` anywhere you do not want invoices raised. |

---

## Stage 1 — Prove the machine, mailing nobody

With `EMAIL_PROVIDER=console`:

```bash
cd server

# 1. Onboard a fake client
npm run add-client -- --company "Preflight Co" --email preflight@example.invalid \
  --service "POS Pro + Support" --amount 12500 --due-day 5 --start 2026-08-01

# 2. See what would be billed — changes nothing
npm run jobs:run -- generate --dry

# 3. Raise it for real
npm run jobs:run -- generate
```

Then check all four of these:

```sql
-- one invoice, numbered 00001, due inside its own period
SELECT invoiceNumber, DATE(periodStart), DATE(dueDate), total, status FROM invoices;

-- the email that would have gone out
SELECT type, status, toEmail, subject FROM email_logs;
```

```bash
ls -la storage/invoices/2026/     # the PDF exists
```

And open the PDF. Check the badge does **not** say DRAFT, that no columns
overlap, and that your bank details in Settings are correct — a wrong account
number on a real invoice is a very awkward email to send afterwards.

### Walk the reminder ladder

```bash
npm run jobs:run -- reminders 2026-07-29   # 7 days before
npm run jobs:run -- reminders 2026-08-02   # 3 days before
npm run jobs:run -- reminders 2026-08-05   # due today
npm run jobs:run -- overdue   2026-08-10
npm run jobs:run -- reminders 2026-08-08   # 3 days past
npm run jobs:run -- reminders 2026-08-12   # 7 days past
```

`SELECT type, subject FROM email_logs ORDER BY createdAt;` should read:

```
REMINDER_BEFORE_7    … due in 7 days
REMINDER_BEFORE_3    … due in 3 days
REMINDER_DUE_TODAY   Due today: …
REMINDER_OVERDUE_3   … (3 days past due)
REMINDER_OVERDUE_7   … (7 days past due)
```

If any of those day counts is wrong, stop — do not go live with it.

### Prove a payment stops the chasing

```bash
# record it through the UI, or:
curl -X POST http://localhost:4000/api/v1/payments -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"invoiceId":"<id>","amount":12500,"method":"BANK_TRANSFER","paidAt":"2026-08-03"}'
```

The invoice must flip to `PAID`, a `PAYMENT_RECEIVED` email must be logged, and
every reminder after that date must return `processed: 0`. A system that keeps
chasing a client who has already paid costs you the relationship, not the money.

### Then wipe it

```sql
SET FOREIGN_KEY_CHECKS=0;
TRUNCATE email_logs; TRUNCATE invoice_items; TRUNCATE payments; TRUNCATE invoices;
TRUNCATE subscriptions; TRUNCATE clients; TRUNCATE job_runs; TRUNCATE number_sequences;
SET FOREIGN_KEY_CHECKS=1;
```

`number_sequences` matters — leave it and your real client's first invoice is
INV-2026-00002.

---

## Stage 2 — Host it

Full walkthrough in [GOING-LIVE.md](./GOING-LIVE.md). Recommendation: one small
VPS (2 vCPU / 4 GB). Not serverless — this app runs cron and writes PDFs to
disk, and both fight a serverless model for no benefit at this size.

Before you point a client at it:

- [ ] TLS working (`certbot --nginx -d billing.yourdomain.com`)
- [ ] Admin password changed from the seed value
- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGINS` lists your exact domain, no trailing slash
- [ ] `pm2 save && pm2 startup` so it survives a reboot
- [ ] Nightly `mysqldump` **and** a `storage/` tarball to a cron job
- [ ] One backup restored into a scratch database — do this once, now

---

## Stage 3 — Real email

1. Verify your sending domain in Resend (DKIM + SPF in DNS, wait for
   **Verified**). An unverified domain lands invoices in spam, and a payment
   reminder in spam is an unpaid invoice.
2. `MAIL_FROM_EMAIL` must be on that verified domain.
3. Add **yourself** as a client first and let the job invoice you. Read it on
   your phone: the amount, the due date, the PDF attachment, the sender name.
4. Delete yourself, wipe as above.
5. Only then add the real client.

---

## Stage 4 — Go live

```bash
npm run add-client -- --company "…" --email "…" --service "…" \
  --amount … --due-day … --start YYYY-MM-01 --dry     # read it back
npm run add-client -- …                                # apply

npm run jobs:run -- generate --dry                     # confirm once more
npm run jobs:run -- generate                           # raises + emails
```

**`--start` is the first month you want to bill, not today.** Setting it to a
past month back-bills every period since, up to 12, and emails all of them. A
June start date in August produces three invoices and three emails in one run.
`--dry` shows you exactly that before it happens.

Then confirm what actually left the building:

```sql
SELECT type, status, toEmail, subject, sentAt FROM email_logs ORDER BY createdAt DESC LIMIT 5;
```

`status = SENT` with a `providerMessageId` means Resend accepted it. `FAILED`
puts the reason in `lastError`, and the retry job tries again every 15 minutes.

---

## What runs by itself afterwards

Daily at `CRON_DAILY_AT` (08:00 default, in your `TIMEZONE`), in this order:

1. **mark-overdue** — statuses reflect reality before anything is written
2. **generate-invoices** — raises due invoices, emails them if `autoSend`
3. **send-reminders** — sends whatever today's offsets call for

Plus **retry-emails** every 15 minutes and **maintenance** at 03:30.

The order is one pipeline, not three cron entries: reminders running before
the overdue sweep would tell a client an invoice is "due today" when it went
past due yesterday.

Every reminder is deduped on `(invoiceId, type)`, so re-running a day after an
outage cannot mail the client twice.

---

## Weekly, thirty seconds

```sql
SELECT type, toEmail, lastError FROM email_logs WHERE status = 'FAILED';

SELECT invoiceNumber, dueDate, total, amountPaid, status FROM invoices
 WHERE status IN ('SENT','PARTIALLY_PAID','OVERDUE') ORDER BY dueDate;
```

Both empty and nothing overdue is the healthy state.
