# AutoBilling on Oracle Cloud — Always Free, production-grade

Everything on one Oracle Ampere ARM instance: MySQL, the API with its in-process
scheduler, and the admin UI served as static files on the same origin. **Real
recurring cost: $0.** Not $0 for twelve months — $0 for as long as the Always
Free tier exists.

This guide is Oracle-specific. The generic VPS walkthrough in
[`GOING-LIVE.md`](GOING-LIVE.md) is correct but would leave you stuck on four
things that are unique to OCI, all of which are handled below:

| Trap | Symptom if you miss it |
|---|---|
| Host firewall on top of the VCN | Ports opened in the console, site still times out |
| A1 capacity scarcity | `Out of host capacity` on every create attempt |
| Idle instance reclamation | A low-traffic billing box quietly stopped after a week |
| Outbound SMTP blocked | Invoices generate perfectly and never arrive |

---

## 0. The architecture, and why

```
                    Reserved public IP
                            │
                    ┌───────┴────────┐
     :443/:80  ───▶ │     nginx      │  TLS (Let's Encrypt), gzip, rate limiting
                    └───┬────────┬───┘
        static SPA ─────┘        └───── proxy_pass 127.0.0.1:4000
      /var/www/autobilling               ┌──────────────────────────┐
                                         │  Node 22 · Express       │
                                         │  PM2, 1 instance         │
                                         │  node-cron 08:00 daily   │
                                         └────────────┬─────────────┘
                                                      │ 127.0.0.1:3306
                                         ┌────────────┴─────────────┐
                                         │  MySQL 8 (localhost only)│
                                         └──────────────────────────┘
                       nightly mysqldump ──▶ OCI Object Storage (free 20 GB)
```

Three decisions worth defending:

**One origin, not two.** The SPA and the API answer on the same hostname. Your
refresh-token cookie stays first-party — no `SameSite=None`, no `COOKIE_DOMAIN`,
no CORS preflight on every request. `web/` is therefore built with
`VITE_API_URL=` **empty**, on purpose.

**One API process, forever.** `node-cron` runs inside the server
(`server/src/jobs/scheduler.ts`), so two instances mean two billing pipelines.
The `job_runs` unique constraint makes that *safe* but wasteful, and PM2 cluster
mode buys you nothing at this scale. `instances: 1` in
[`ecosystem.config.cjs`](../server/ecosystem.config.cjs) is deliberate — leave it.

**MySQL on the same box, not Autonomous Database.** Oracle's free Autonomous DB
is Oracle-flavoured; your Prisma schema is `provider = "mysql"`. Local MySQL over
a loopback socket is also faster than any network database, and 24 GB of RAM
makes it a non-issue.

---

## 1. What Always Free actually gives you

The relevant allowances (verify current numbers at
`oracle.com/cloud/free` — Oracle adjusts them):

| Resource | Always Free allowance | What we use |
|---|---|---|
| Ampere A1 compute | 4 OCPU + 24 GB RAM total, up to 4 VMs | one 4 OCPU / 24 GB VM |
| Block storage | 200 GB total | 100 GB boot volume |
| Outbound transfer | 10 TB / month | rounding error |
| Object Storage | 20 GB | offsite DB backups |
| Reserved public IP | included | one |
| Monitoring + alarms | included | CPU / memory alerts |

**Take the whole A1 allocation in one VM.** A1 capacity is the scarce thing (§2);
once you have an instance you keep it, but a *second* create request may fail for
weeks. One 4/24 box comfortably runs AutoBilling **and** Sillara side by side —
separate nginx server blocks, separate databases, separate PM2 apps — which is
almost certainly where you're heading.

The x86 `VM.Standard.E2.1.Micro` shape (1 GB RAM) is also free. Don't. `npm ci`
plus a Vite build plus MySQL on 1 GB is a bad afternoon.

---

## 2. Account, region, and the capacity problem

**Region is permanent.** Your home region cannot be changed after signup, and
Always Free resources only live there. From Colombo:

1. `ap-mumbai-1` — lowest latency (~40 ms), heaviest A1 contention
2. `ap-hyderabad-1` — ~50 ms, usually more A1 capacity available
3. `ap-singapore-1` — ~60 ms, good availability

Pick Hyderabad or Singapore if Mumbai refuses to give you an instance. The
latency difference is invisible for an admin dashboard.

### `Out of host capacity` — the actual fix

Free-tier A1 requests are served at the lowest priority. Three escalating
responses:

1. **Retry at off-peak hours** (02:00–06:00 local to the region) and cycle
   through availability domains.
2. **Ask for less** — try 2 OCPU / 12 GB, which frequently succeeds when 4/24
   doesn't. You can scale the shape up later, in place.
3. **Upgrade to Pay As You Go.** This is the move most people miss. A PAYG
   account still gets every Always Free resource **free** — you are billed only
   for what exceeds the allowances. What it buys you is normal-priority capacity
   and, crucially, exemption from idle reclamation (§7). Requires a card;
   set a $1 budget alert and you will see any accidental charge immediately.

If you want zero card on file, stay on Always Free and accept the retry loop.
If this box is going to invoice real clients, upgrade to PAYG.

---

## 3. Create the instance

**Compute → Instances → Create instance**

| Field | Value |
|---|---|
| Image | Canonical **Ubuntu 24.04** |
| Shape | **VM.Standard.A1.Flex**, 4 OCPU, 24 GB (aarch64) |
| Networking | Create new VCN, **public subnet**, assign public IPv4 |
| SSH keys | Paste your public key (`cat ~/.ssh/id_ed25519.pub`) |
| Boot volume | **100 GB**, VPU 10 (Balanced) |

Everything in this stack is either pure JavaScript (`pdf-lib`, `qrcode`,
`bcryptjs`) or ships native aarch64 builds (Node, Prisma engines, MySQL), so ARM
costs you nothing. Prisma's engine is generated **on the box** by `deploy.sh`, so
its default `native` binary target resolves correctly. Only if you ever move the
build into x86 CI do you need to add to `schema.prisma`:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-arm64-openssl-3.0.x"]
}
```

### Make the IP permanent

The default public IP is *ephemeral* — it changes if the instance is stopped and
started, which silently breaks your DNS.

**Instance → Attached VNICs → (primary) → IPv4 Addresses → Edit → Public IP →
Reserved → Create new reserved IP.**

Do this before you touch DNS.

---

## 4. Open the network — both layers

This is the single most common "my Oracle site is down" cause. There are **two**
firewalls and they are unrelated.

### Layer 1 — VCN Security List

**Networking → VCN → Subnet → Security List → Add Ingress Rules**

| Source CIDR | Protocol | Dest. port | Purpose |
|---|---|---|---|
| `0.0.0.0/0` | TCP | 80 | HTTP (certbot challenge + redirect) |
| `0.0.0.0/0` | TCP | 443 | HTTPS |
| *your IP*`/32` | TCP | 22 | SSH — tighten the default rule |

### Layer 2 — the instance's own iptables

Oracle's Ubuntu image ships an `INPUT` chain ending in `REJECT`. Opening ports in
the console alone gets you a connection that hangs and dies. `bootstrap.sh` does
this for you:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

> **Never run `ufw enable` on an OCI Ubuntu image** unless you have explicitly
> allowed 22 first. It replaces the rule set and has locked out more people than
> any other single command on this platform.

---

## 5. DNS

Your DNS provider → `example.com` → DNS Records → **A record**:

| Host | Value | TTL |
|---|---|---|
| `billing` | your **reserved** public IP | 5 min |

Confirm before continuing — certbot will fail against a stale record:

```bash
dig +short billing.example.com
```

---

## 6. Provision the box

SSH in (`ssh ubuntu@<your-ip>`), then:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo mkdir -p /srv && sudo chown $USER /srv
git clone https://github.com/YOURUSER/autobilling.git /srv/autobilling
sudo DOMAIN=billing.example.com bash /srv/autobilling/deploy/oracle/bootstrap.sh
```

[`bootstrap.sh`](../deploy/oracle/bootstrap.sh) is idempotent and installs:
system timezone `Asia/Colombo` (so `node-cron` and the backup cron agree), a
4 GB swapfile, the host firewall rules, Node 22 + PM2 + log rotation, MySQL 8
tuned for the box's RAM and bound to loopback, a generated database password at
`/root/.autobilling-db-password`, an unprivileged `autobilling` service user,
fail2ban on SSH, unattended security upgrades, and the nginx site.

### Configure the app

```bash
sudo chown -R autobilling:autobilling /srv/autobilling
sudo -u autobilling cp /srv/autobilling/server/.env.example /srv/autobilling/server/.env
node -e "for (const k of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','ENCRYPTION_KEY']) console.log(k+'='+require('crypto').randomBytes(32).toString('hex'))"
sudo -u autobilling nano /srv/autobilling/server/.env
```

Generate **fresh** secrets on the server. Do not copy the ones from your Mac —
your laptop `.env` has been through git status, screenshots and backups.

```ini
NODE_ENV=production
PORT=4000
APP_URL=https://billing.example.com
API_URL=https://billing.example.com
CORS_ORIGINS=https://billing.example.com
# COOKIE_DOMAIN stays unset — same-origin needs nothing.
# WEB_DIST stays unset — nginx serves the SPA, not Express.

DATABASE_URL="mysql://autobilling:PASSWORD_FROM_/root/.autobilling-db-password@127.0.0.1:3306/autobilling?connection_limit=10&pool_timeout=20"

JWT_ACCESS_SECRET=<64 hex>
JWT_REFRESH_SECRET=<a different 64 hex>
ENCRYPTION_KEY=<exactly 64 hex>

EMAIL_PROVIDER=resend            # see §8 — SMTP will not work here
RESEND_API_KEY=re_xxxxxxxx

STORAGE_DIR=./storage
TIMEZONE=Asia/Colombo
CRON_ENABLED=true
LOG_LEVEL=info
```

```bash
sudo chmod 600 /srv/autobilling/server/.env
```

`server/src/config/env.ts` validates all of this at boot and refuses to start on
a half-configured billing engine — a failed start with a clear error is the
intended behaviour, not a bug.

### First release

```bash
sudo -u autobilling bash /srv/autobilling/deploy/oracle/deploy.sh --first-run
```

[`deploy.sh`](../deploy/oracle/deploy.sh) installs dependencies, generates the
Prisma client, runs `migrate deploy` **before** restarting (so the live process
never sees a schema it wasn't compiled against), builds the SPA with an empty
`VITE_API_URL`, publishes it to `/var/www/autobilling`, restarts PM2, and refuses
to report success until `/health` returns `healthy`.

Make PM2 survive reboots:

```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u autobilling --hp /home/autobilling
sudo -u autobilling pm2 save
```

---

## 7. TLS

```bash
sudo certbot --nginx -d billing.example.com --redirect \
     -m billing@example.com --agree-tos --no-eff-email
sudo systemctl status certbot.timer     # auto-renewal, should be "active (waiting)"
```

Certbot rewrites the site file in place to add the 443 block and the HTTP
redirect. Helmet already sends HSTS with a one-year max-age when
`NODE_ENV=production`.

### Idle reclamation — do not skip this

On an **Always Free** (non-PAYG) tenancy, Oracle reclaims compute instances that
sit near-idle for about a week. An internal billing tool used by three people
that spikes for ninety seconds each morning is exactly that profile. Two
defences, both worth having:

- Upgrade to **Pay As You Go** (§2). Reclamation does not apply. This is the real fix.
- Point a free **UptimeRobot** (or Better Stack) monitor at
  `https://billing.example.com/health` every 5 minutes. You get genuine
  downtime alerts *and* a permanent low-level heartbeat.

Also add an OCI alarm — **Observability → Alarms** — on CPU utilisation > 85%
for 5 minutes, notifying your email. Free, and it tells you about a runaway job
before your clients do.

---

## 8. Email — the Oracle-specific rule

**Oracle blocks outbound TCP port 25 on every instance, permanently.** On
free/new tenancies, outbound 465 and 587 to arbitrary hosts are also commonly
throttled or blocked.

For this app that means: **use Resend, which is plain HTTPS on 443.** Keep
`EMAIL_PROVIDER=resend`. The SMTP failover path documented in
[`GOING-LIVE.md §2.4`](GOING-LIVE.md) is a fine idea on other hosts and an
unreliable one here — do not let it be your only rail, and do not debug a
"stuck" queue for an hour before remembering this section.

Verify from the box itself before you trust it:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.resend.com   # expect 200/401, not a hang
```

Then Settings → Email delivery → send a test email, and check spam. DNS records
for Resend are covered in [`GOING-LIVE.md §2.1`](GOING-LIVE.md) — unchanged here.

---

## 9. Backups, offsite, with no keys on the box

The database *is* your receivables ledger. Local dumps handle mistakes; only an
offsite copy handles losing the instance.

### Object Storage bucket

**Storage → Buckets → Create Bucket** → name `autobilling-backups`, Standard
tier, private. Then set a **lifecycle rule** to delete objects older than 90
days so you stay inside the free 20 GB.

### Instance principal auth — no API keys stored anywhere

**Identity → Dynamic Groups → Create**, name `billing-vm`, rule:

```
ANY {instance.id = 'ocid1.instance.oc1..your-instance-ocid'}
```

**Identity → Policies → Create**, in the root compartment:

```
Allow dynamic-group billing-vm to manage objects in compartment <your-compartment> where target.bucket.name = 'autobilling-backups'
Allow dynamic-group billing-vm to read buckets in compartment <your-compartment>
```

Install the CLI and schedule it:

```bash
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
sudo crontab -e
```

```cron
15 2 * * * OCI_BUCKET=autobilling-backups /bin/bash /srv/autobilling/deploy/oracle/backup.sh >> /var/log/autobilling-backup.log 2>&1
```

[`backup.sh`](../deploy/oracle/backup.sh) takes a `--single-transaction`
mysqldump (consistent, non-locking — it cannot deadlock against the 08:00
billing run), verifies the gzip actually decompresses and isn't suspiciously
small, archives `storage/` weekly, uploads offsite, and prunes to 14 days local.

### Prove the restore — once, now

```bash
sudo mysql -e "CREATE DATABASE restore_test"
zcat /var/backups/autobilling/db-$(date +%F)*.sql.gz | sudo mysql restore_test
sudo mysql -e "SELECT COUNT(*) FROM restore_test.invoices"
sudo mysql -e "DROP DATABASE restore_test"
```

A backup you have never restored is a hope, not a backup.

---

## 10. Hardening checklist

Most of this `bootstrap.sh` already did; confirm rather than assume.

- [ ] SSH: key-only (`PasswordAuthentication no` — the OCI image default), port 22 restricted to your IP in the security list
- [ ] fail2ban active: `sudo fail2ban-client status sshd`
- [ ] MySQL on loopback only: `ss -ltn | grep 3306` shows `127.0.0.1:3306`
- [ ] `server/.env` is `chmod 600` and owned by `autobilling`
- [ ] API runs as `autobilling`, never root: `ps -o user= -C node`
- [ ] Unattended upgrades on: `systemctl status unattended-upgrades`
- [ ] Admin seed password changed from `ChangeMe123!` at first login
- [ ] `sudo reboot` once, then confirm PM2, MySQL and nginx all came back by themselves

Verify the whole path from outside:

```bash
curl -sS https://billing.example.com/health
curl -sSI https://billing.example.com | grep -i strict-transport-security
curl -sS https://billing.example.com/storage/invoices/ -o /dev/null -w '%{http_code}\n'  # expect 401
```

---

## 11. Day-two operations

```bash
# Release a new version
sudo -u autobilling bash /srv/autobilling/deploy/oracle/deploy.sh

# Logs
sudo -u autobilling pm2 logs autobilling-api --lines 100
sudo tail -f /var/log/nginx/autobilling.error.log

# Did this morning's pipeline run?
sudo mysql autobilling -e "SELECT jobName, runKey, status, startedAt, finishedAt FROM job_runs ORDER BY startedAt DESC LIMIT 10"

# Run a job by hand (dry run writes nothing)
cd /srv/autobilling/server && sudo -u autobilling npm run jobs:run -- generate --dry

# Resource sanity
htop; df -h; free -m
```

### Failure playbook

| Symptom | Cause | Fix |
|---|---|---|
| Site times out, nginx is running | Host iptables `REJECT` | §4 layer 2 |
| Site refused, ports open on host | VCN ingress rule missing | §4 layer 1 |
| `Out of host capacity` | A1 contention | §2 — smaller shape, other AD, or PAYG |
| Instance stopped on its own | Idle reclamation | §7 — PAYG + uptime monitor |
| Invoices generated, none delivered | SMTP ports blocked | §8 — Resend over 443 |
| `502 Bad Gateway` | API down or unhealthy | `pm2 logs`; `.env` validation error at boot |
| API won't boot, no useful log | env validation failed | Run `node dist/server.js` in the foreground — it prints the exact bad key |
| Billing ran twice | Two API processes | `pm2 list` — there must be exactly one |
| `PrismaClientInitializationError` after an OS upgrade | OpenSSL moved under the engine | `npx prisma generate && npm run build` |

---

## 12. Adding Sillara to the same box later

You have the headroom; keep the isolation.

```bash
sudo mysql -e "CREATE DATABASE sillara CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
# separate MySQL user, separate /srv/sillara, separate PM2 app on :4100,
# a second nginx server block for app.sillara.com, and its own certbot -d flag.
```

Two things to decide before you do: MySQL's `innodb_buffer_pool_size` should be
re-tuned for two databases, and Sillara's public traffic profile is nothing like
AutoBilling's internal one — when it takes real load, that is the moment to
split it onto its own instance (you still have 0 OCPU of the free allocation
left, so that means PAYG). Design for the split now, don't pay for it yet.

---

## What would ever start charging you

Nothing in this guide costs money. Things that would:

- Block storage beyond **200 GB total** (boot volumes count — our 100 GB leaves room for one more instance)
- Object Storage beyond **20 GB** (the 90-day lifecycle rule prevents this)
- Egress beyond **10 TB/month** (you will not get close)
- Compute beyond 4 OCPU / 24 GB of A1, or any non-A1 shape beyond the two free micros
- A second reserved public IP that isn't attached to anything

On PAYG, set **Billing → Budgets → $1 with an 80% alert**. You'll know within a
day if anything drifts out of the free tier.
