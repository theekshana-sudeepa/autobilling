# Your first real client — the runbook

`GOING-LIVE.md` covers hosting in depth. This is the short path: get the box
up, prove the machine works **without emailing anyone**, then let it bill one
real client on a schedule.

Read the order literally. Every step before Stage 4 is reversible; Stage 4
sends mail to a paying customer and cannot be taken back.

---

## Stage 0 — What you are deciding

Before touching a terminal, write down five values. Everything else follows.

| Value | Example | Why it matters |
|---|---|---|
| Client company name | Silverline Supermarket | Prints on every invoice |
| Billing email | accounts@silverline.lk | Where invoices and reminders land |
| Service name | POS Pro + Support | The invoice line item |
| Amount per month | 12500 LKR | Tax-exclusive |
| Due day | 5 | Day of month, **1–28 only** |

Due day is capped at 28 on purpose: there is no 31st of February, and a
billing system that has to invent a fallback date will eventually invent the
wrong one.

---

## Stage 1 — Host it

The recommendation for an internal admin tool with one or two users is a
**single small VPS** (2 vCPU / 4 GB, about $12–24/month — Hetzner, DigitalOcean,
Vultr, Linode). Not serverless: this app runs cron and writes PDFs to disk,
and both fight a serverless model for no benefit at this size.

Full walkthrough with Nginx, TLS and PM2 is in
[GOING-LIVE.md § Stage 3](./GOING-LIVE.md). The short version:

```bash
# On the VPS, as root
apt update && apt install -y nginx mysql-server git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm i -g pm2

mysql -e "CREATE DATABASE autobilling CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'autobilling'@'localhost' IDENTIFIED BY 'A_STRONG_PASSWORD';
GRANT ALL ON autobilling.* TO 'autobilling'@'localhost'; FLUSH PRIVILEGES;"

cd /srv && git clone <your-repo> autobilling && cd autobilling/server
cp .env.example .env && nano .env         # see Stage 2
npm ci && npx prisma generate && npx prisma migrate deploy && npm run seed
npm run build
mkdir -p logs storage && pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

Point an A record at the VPS, then `certbot --nginx -d billing.yourdomain.com`.

**Two things people forget:**

- `STORAGE_DIR` holds your invoice PDFs. It must be on disk that gets backed
  up, and it must survive a redeploy. Do not put it inside the git checkout.
- Set `TIMEZONE=Asia/Colombo` (or wherever you bill from). It decides what
  "today" means for the whole billing engine — the invoice dates themselves
  are stored in UTC and are timezone-independent, but *when the job fires* is
  not.

---

## Stage 2 — Email, before any client exists

Reminders are the product. Get this right while nobody is receiving them.

### 2.1 Verify a sending domain

Create a [Resend](https://resend.com) account, add your domain, and paste the
DKIM/SPF records into DNS. Wait for **Verified**.

Sending from an unverified domain, or from a free Gmail address, lands
invoices in spam. A payment reminder in spam is an unpaid invoice.

### 2.2 Configure

```ini
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxx
MAIL_FROM_NAME="AutoBilling"
MAIL_FROM_EMAIL=billing@yourdomain.com     # must be on the verified domain
MAIL_REPLY_TO=billing@yourdomain.com
```

Keep `EMAIL_PROVIDER=console` until you have finished Stage 3. In console mode
every email is rendered, logged and recorded in `email_logs` — but never sent.
That is how you read the exact text a client would get without mailing them.

### 2.3 Send yourself one

Add **yourself** as the first client, let the job invoice you, and read what
arrives on your phone. Check the amount, the due date, the PDF attachment, and
what the "from" name looks like in a real inbox.

```bash
npm run add-client -- --company "Internal Test" --email you@yourdomain.com \
  --service "Test line" --amount 100 --due-day 5
npm run jobs:run -- generate
```

Then delete it before Stage 4:

```sql
DELETE FROM email_logs;  DELETE FROM invoice_items;  DELETE FROM invoices;
DELETE FROM subscriptions;  DELETE FROM clients;  DELETE FROM number_sequences;
```

---

## Stage 3 — Add the client

```bash
cd /srv/autobilling/server

npm run add-client -- \
  --company "Silverline Supermarket" \
  --contact "Nuwan Perera" \
  --email   accounts@silverline.lk \
  --phone   0771234567 \
  --service "POS Pro + Support" \
  --amount  12500 \
  --due-day 5 \
  --start   2026-08-01 \
  --dry
```

`--dry` prints exactly what would be written and changes nothing. Read it back
against your Stage 0 table, then run it again without `--dry`.

The script refuses to create a second subscription for an email that already
has one, because that is how a client gets billed twice.

### What `--start` means

The **first month you want to bill for**, not today's date. Setting it to a
past month back-bills: the generator raises an invoice for every period from
that month up to now, capped at 12. If this client has been paying you outside
the system since June, `--start 2026-06-01` produces the June, July and August
invoices in one run — which may be exactly right, or a nasty surprise for the
client. Check with `--dry` on the generator before committing:

```bash
npm run jobs:run -- generate --dry
```

---

## Stage 4 — Go live

Only now switch `EMAIL_PROVIDER` to `resend` and restart:

```bash
nano .env && pm2 restart autobilling-api
```

Raise the first invoice deliberately rather than waiting for the cron, so you
are watching when it happens:

```bash
npm run jobs:run -- generate --dry    # confirm one more time
npm run jobs:run -- generate          # raises + emails it
```

Then check what actually went out:

```sql
SELECT type, status, toEmail, subject, sentAt FROM email_logs ORDER BY createdAt DESC LIMIT 5;
```

`status = SENT` with a `providerMessageId` means Resend accepted it. If it says
`FAILED`, the reason is in `lastError` and the retry job will try again every
15 minutes.

---

## What runs by itself from here

`CRON_ENABLED=true` runs the pipeline daily at `CRON_DAILY_AT` (08:00 by
default, in your `TIMEZONE`):

| Order | Job | What it does |
|---|---|---|
| 1 | mark-overdue | Moves past-due invoices to OVERDUE first, so reminders see the truth |
| 2 | generate-invoices | Raises invoices whose period has arrived, emails them if `autoSend` |
| 3 | send-reminders | Sends whatever today's offsets call for |
| — | retry-emails | Every 15 min, drains transient delivery failures |
| — | maintenance | 03:30, prunes tokens, job runs and old logs |

The order is enforced in one pipeline, not three cron entries. Reminders
running before the overdue sweep would tell a client an invoice is "due today"
when it went past due yesterday.

### The reminder ladder

Configured in Settings as `reminderOffsets`, default `[-7, -3, 0, 3, 7]`:

```
  7 days before  →  "Reminder: Rs.12,500.00 due in 7 days"
  3 days before  →  "Reminder: Rs.12,500.00 due in 3 days"
  on the day     →  "Due today: Rs.12,500.00"
  3 days after   →  "Overdue: … (3 days past due)"
  7 days after   →  "Overdue: … (7 days past due)"
```

Each one sends at most once per invoice — the dedupe key is
`(invoiceId, type)`, so re-running a day's reminders after an outage will not
mail the client twice.

---

## Operating it

```bash
pm2 logs autobilling-api --lines 100     # what happened
npm run jobs:run -- generate --dry       # what would be billed
npm run jobs:run -- reminders --dry      # who would be chased
npm run jobs:run -- pipeline             # run the whole day now
```

Weekly, two queries:

```sql
-- anything that failed to send
SELECT type, toEmail, lastError FROM email_logs WHERE status = 'FAILED';

-- anything the client owes
SELECT invoiceNumber, dueDate, total, amountPaid, status FROM invoices
 WHERE status IN ('SENT','PARTIALLY_PAID','OVERDUE') ORDER BY dueDate;
```

Recording a payment marks the invoice PAID and stops the reminder ladder for
it immediately — do that the day the money lands, or the system will keep
chasing a client who has already paid you. That is the one failure mode here
that costs you a relationship rather than a rupee.

---

## Backups

This database is your receivables ledger. Losing it means not knowing who owes
you money.

```bash
0 2 * * * mysqldump --single-transaction --routines autobilling | gzip > /root/backups/autobilling-$(date +\%F).sql.gz
0 3 * * * tar czf /root/backups/storage-$(date +\%F).tar.gz /srv/autobilling/server/storage
0 4 * * 0 find /root/backups -mtime +30 -delete
```

Restore one into a scratch database once, now, while it does not matter. A
backup you have never restored is a hope, not a backup.
