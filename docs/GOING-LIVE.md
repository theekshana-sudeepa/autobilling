# AutoBilling — Going Live Guide

From zero to "my clients receive real invoice emails" in three stages:
local run → real email → hosted. Written for any custom domain (`example.com`).

---

## Stage 1 — Run it locally (15 minutes)

### 1.1 Start MySQL
Start your local MySQL 8 instance (Homebrew, Docker, or XAMPP — only MySQL is needed).

### 1.2 Create the database
```bash
mysql -u root -e "CREATE DATABASE autobilling CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

### 1.3 Configure the server
```bash
cd server && cp .env.example .env
```
Generate the three secrets and paste them into `.env`:
```bash
node -e "for (const k of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','ENCRYPTION_KEY']) console.log(k+'='+require('crypto').randomBytes(32).toString('hex'))"
```
For now also set in `.env`:
```
EMAIL_PROVIDER=console      # logs emails instead of sending — safe while testing
```

### 1.4 Install, migrate, seed, run
```bash
cd server && npm install
npx prisma migrate dev --name init
npm run seed
npm run dev
```

### 1.5 Run the web app (second terminal)
```bash
cd web && cp .env.example .env && npm install && npm run dev
```

Open http://localhost:5173 — sign in with `admin@example.com` / `ChangeMe123!`.

### 1.6 Prove the machine works (still fake email)
1. Add a client (use **your own email** as the client's email)
2. Add a subscription (due day = today's day-of-month, so it invoices immediately)
3. Terminal 3:
```bash
cd server && npm run jobs:run -- generate
```
4. Watch the server logs: invoice created, PDF built, "[console mailer] email not actually sent".
5. Run the same command again — everything reports `skipped`, nothing duplicates. That's the safety system working.

---

## Stage 2 — Real email from billing@example.com

This is the only genuinely fiddly step, and it's DNS, not code.

### 2.1 Resend account
1. Sign up at **resend.com** (free tier = 3,000 emails/month — at ~6 emails per
   client per month that covers ~500 clients; you'll be fine for a long time).
2. **Domains → Add Domain → `example.com`**.
3. Resend shows you 3–4 DNS records (DKIM TXT records + an MX/TXT pair for the
   bounce subdomain). Copy each one **exactly** into your DNS provider's record manager.
4. Wait for Resend to show **Verified** (minutes to a few hours).
5. Add one more TXT record yourself for DMARC (deliverability insurance):
   - Host: `_dmarc`  ·  Value: `v=DMARC1; p=none; rua=mailto:billing@example.com`
6. **API Keys → Create** → copy the `re_...` key.

### 2.2 Switch the app to real sending
In `server/.env`:
```
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxxx
MAIL_FROM_NAME="AutoBilling"
MAIL_FROM_EMAIL=billing@example.com
MAIL_REPLY_TO=billing@example.com
```
Restart the server.

### 2.3 Test — in this exact order
1. **Settings → Email delivery → Send a test email** to yourself. Check inbox
   AND spam. (If spam: DNS not fully propagated yet — wait, don't tweak.)
2. Your test client from Stage 1 → open its unpaid invoice → **Send invoice**.
   You should receive the branded email with the PDF attached.
3. Record a payment on that invoice → receipt email arrives, reminders stop.

Only after all three pass do you add a real client.

### 2.4 (Optional) SMTP fallback
Settings → Email delivery → fill your custom/cPanel mailbox SMTP
(`mail.example.com`, port 465, the mailbox password). If Resend is ever
unreachable the system fails over automatically. Skip it if you don't have the
details handy — Resend alone is fine.

---

## Stage 3 — Hosting

> **Hosting on Oracle Cloud Always Free?** Follow
> [`DEPLOY-ORACLE.md`](DEPLOY-ORACLE.md) instead of this stage. Same
> architecture, $0/month, plus the four OCI-specific traps (host firewall, A1
> capacity, idle reclamation, blocked SMTP ports) that this generic guide does
> not cover. Stages 1 and 2 above still apply.
>
> **Hosting on AWS Free Tier?** Follow [`DEPLOY-AWS.md`](DEPLOY-AWS.md)
> instead. Same architecture, but a much smaller 1 GB RAM box, so it covers
> swap sizing, a tuned MySQL config, Security Group setup, and S3-based
> backups via an IAM role. Stages 1 and 2 above still apply.

### The recommendation (internal admin tool, 1–3 users)

**One small VPS, everything on it, one domain.** Frontend served as static
files by Nginx, API proxied on the same domain — same-origin means zero
CORS/cookie complexity, and the cron runs 24/7 next to the database.

| Item | Choice | Cost |
|---|---|---|
| VPS | Hetzner CX22 / DigitalOcean / Vultr — Ubuntu 24.04, 2GB RAM | ~$5–6/mo |
| Domain | `billing.example.com` A-record → VPS IP (your DNS provider) | already owned |
| Email | Resend free tier | $0 |
| **Total** | | **~$6/mo** |

> **Why not Vercel for the frontend?** You can — but it forces cross-domain
> cookies (`COOKIE_DOMAIN`, SameSite=None) and a second deployment to manage,
> for zero benefit on an internal tool. One box, one domain, done.
>
> **Shared cPanel Node hosting?** Works, but cPanel restarts kill the
> in-process scheduler. If you insist: set `CRON_ENABLED=false` and add cPanel
> cron jobs calling `node dist/jobs/cli.js pipeline` daily and `... retry`
> every 15 min. The $6 VPS is less pain.

### 3.1 Put the code in git
```bash
git init && git add -A && git commit -m "AutoBilling v1"
```
Push to your GitHub repository:
```bash
git remote add origin git@github.com:YOURUSER/autobilling.git && git push -u origin main
```

### 3.2 DNS
Your DNS provider → **A record**: host `billing`, value = your VPS IP.

### 3.3 On the VPS (run over SSH)

```
# base software
apt update && apt install -y nginx mysql-server git certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs
npm i -g pm2

# database + user
mysql -e "CREATE DATABASE autobilling CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'autobilling'@'localhost' IDENTIFIED BY 'PICK_A_STRONG_PASSWORD';
GRANT ALL ON autobilling.* TO 'autobilling'@'localhost'; FLUSH PRIVILEGES;"

# code
mkdir -p /srv && cd /srv
git clone https://github.com/YOURUSER/autobilling.git
cd autobilling/server
cp .env.example .env && nano .env        # see production values below

npm ci
npx prisma generate && npx prisma migrate deploy
npm run build
npm run seed                              # users + settings only (no SEED_DEMO)
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup

# frontend — same-origin build (VITE_API_URL left EMPTY on purpose)
cd /srv/autobilling/web
npm ci && VITE_API_URL= npm run build     # output: /srv/autobilling/web/dist
```

**Production `.env` values that differ from local:**
```
NODE_ENV=production
APP_URL=https://billing.example.com
API_URL=https://billing.example.com
CORS_ORIGINS=https://billing.example.com
DATABASE_URL="mysql://autobilling:PICK_A_STRONG_PASSWORD@127.0.0.1:3306/autobilling?connection_limit=10"
TIMEZONE=Asia/Colombo
CRON_ENABLED=true
```
(Do NOT set `COOKIE_DOMAIN` — same-origin needs nothing.)

### 3.4 Nginx — one domain, static frontend, proxied API

`/etc/nginx/sites-available/autobilling`:
```
server {
    server_name billing.example.com;
    root /srv/autobilling/web/dist;
    index index.html;
    client_max_body_size 8m;

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 75s;
    }
    location /storage/ { proxy_pass http://127.0.0.1:4000; proxy_set_header Host $host; }
    location /health   { proxy_pass http://127.0.0.1:4000; }

    location / { try_files $uri /index.html; }   # SPA fallback
}
```
```
ln -s /etc/nginx/sites-available/autobilling /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot --nginx -d billing.example.com     # free TLS, auto-renews
```

### 3.5 Backups (non-negotiable — this is your receivables ledger)
`crontab -e` on the VPS:
```
0 2 * * * mysqldump --single-transaction autobilling | gzip > /root/backups/db-$(date +\%F).sql.gz
0 3 * * 0 tar czf /root/backups/storage-$(date +\%F).tar.gz /srv/autobilling/server/storage
```
```
mkdir -p /root/backups
```
Once a month, download one backup and confirm it restores. A backup you've
never restored is a hope, not a backup.

### 3.6 Deploying updates later
```
cd /srv/autobilling && git pull
cd server && npm ci && npx prisma migrate deploy && npm run build && pm2 restart autobilling-api
cd ../web && npm ci && VITE_API_URL= npm run build
```

---

## Pre-flight checklist before the first real client

- [ ] Signed in at https://billing.example.com and **changed the admin password** (seed default is `ChangeMe123!`)
- [ ] Settings → Company: logo, address, payment instructions (your real bank details)
- [ ] Test email → inbox, not spam
- [ ] Full dry run on yourself: client → subscription → Run billing now → email + PDF received → Mark paid → receipt received
- [ ] `pm2 logs` after the first real 8:00 AM — one SUCCESS row per job in the pipeline
- [ ] Backup cron installed

Then add your real clients one by one. From that moment, invoicing runs itself.
