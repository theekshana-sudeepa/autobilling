# AutoBilling on AWS Free Tier

Everything on one EC2 instance: MySQL, the API with its in-process scheduler,
and the admin UI served as static files on the same origin — the same
single-origin architecture as [`DEPLOY-ORACLE.md`](DEPLOY-ORACLE.md), adapted
for AWS's much smaller free-tier box.

This guide is AWS-specific. The generic VPS walkthrough in
[`GOING-LIVE.md`](GOING-LIVE.md) is correct but silent on four things unique to
AWS, all handled below:

| Trap | Symptom if you miss it |
|---|---|
| 1 GB RAM instead of Oracle's 24 GB | `npm ci` / Vite build gets OOM-killed |
| Which free tier program you're actually on | Instance type choice that quietly starts billing |
| Elastic IP billed when *not* attached to a running instance | Surprise line item after stopping the box |
| Outbound port 25 blocked (587/465 are fine) | Confusing this with Oracle's *total* SMTP block and over-engineering around it |

---

## 0. The architecture, and why

```
                    Elastic IP (static, free while attached)
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
                       nightly mysqldump ──▶ S3 (via instance IAM role)
```

Same three decisions as the Oracle guide (one origin, one API process, MySQL
on the same box) — see [`DEPLOY-ORACLE.md §0`](DEPLOY-ORACLE.md) if you want
the reasoning. What's different here is the box itself: AWS's free-tier
instance has **1 GB of RAM**, not 24 GB. That single fact drives most of the
deviations in this doc — smaller swap math, a smaller MySQL buffer pool, and a
capped Node heap during builds.

---

## 1. What your account's free tier actually means

You're on AWS's newer **Free Plan** account type, confirmed from Billing and
Cost Management → Free Tier: **$100.00 USD credit, 185 days remaining**, and
"Your free plan account does not get charged" — meaning nothing you do on
this account can put a charge on a card while the plan is active. This is
different from the older 12-month tier that restricted you to specific
instance types (`t2.micro`/`t3.micro`) for the "free" label; here, usage
simply draws down the $100 credit, with no per-service allowance to track.

What that means practically:

- **No card gets charged** while credit remains and the 185-day window hasn't
  lapsed. Once either runs out, the console will prompt **Upgrade plan** — a
  normal pay-as-you-go account — and nothing continues running until you do.
- **Still size the instance to be cheap**, because credit is the thing being
  spent, not "hours of a specific free instance type." A `t3.micro` running
  24/7 in `eu-north-1` costs roughly $7–8/month — the $100 credit comfortably
  outlasts the 185-day window even with margin for a second instance later.
- Set a **budget alert** anyway (Billing → Budgets → create a budget, e.g.
  $80 threshold) so you get an email well before the credit runs low rather
  than finding out when the site stops answering.
- **Put a reminder on your calendar for ~day 170** (before the 185-day
  window closes) to either upgrade the plan or have a plan for what happens
  when it lapses — an unattended lapse means the instance stops, not that it
  silently starts billing.

| Resource | This box uses | Why it's cheap regardless of plan |
|---|---|---|
| EC2 compute | one `t3.micro` (1 vCPU, 1 GB RAM), 24/7 | smallest instance that comfortably runs this stack |
| EBS storage | 20 GB gp3 root volume | well under typical low-cost thresholds |
| Data transfer out | rounding error for an admin tool | negligible |
| Elastic IP | free while attached to a running instance | one, always attached |
| S3 | a few MB/month of gzipped dumps | negligible, 90-day lifecycle rule keeps it small |

`t3.micro` is the pick — 1 vCPU, 1 GB RAM, cheap, and better baseline CPU
performance than `t2.micro` (which is more aggressively credit-throttled). If
`eu-north-1` also offers `t4g.micro` (Graviton/ARM) at a lower hourly rate,
it works fine too — everything in this stack is either pure JS or ships
native arm64 builds — but `t3.micro` is the safer default if you're not sure
it's listed as an option when you launch.

---

## 2. Region

Pick whichever AWS region is closest to your admin users (for example,
**Europe (Stockholm) — `eu-north-1`** or `ap-south-1`). AWS lets you launch
free-tier-eligible instances in most regions, and for an internal billing
dashboard the latency difference between regions is negligible.

---

## 3. Create the instance

**EC2 → Instances → Launch instance**

| Field | Value |
|---|---|
| Name | `autobilling` |
| AMI | **Ubuntu Server 24.04 LTS** (Free tier eligible, marked in the console) |
| Instance type | **t3.micro** (or `t2.micro` if that's what your account's Free Tier page lists) |
| Key pair | Create new → type `ed25519` → **download the `.pem` file, you cannot get it again** |
| Network settings | Create security group, allow SSH (22) from **My IP** only, HTTP (80) from Anywhere, HTTPS (443) from Anywhere |
| Storage | **20 GiB** gp3 (default 8 GiB is too tight once MySQL, node_modules ×2, and swap share it) |

Click **Launch instance**. It's running within ~30 seconds.

```bash
chmod 400 ~/Downloads/autobilling.pem
ssh -i ~/Downloads/autobilling.pem ubuntu@<public-ip-from-console>
```

### Make the IP permanent — Elastic IP

The default public IP changes if you ever stop/start the instance (silently
breaking DNS). Fix it once:

**EC2 → Network & Security → Elastic IPs → Allocate Elastic IP address →
Allocate.** Then select it → **Actions → Associate Elastic IP address** →
pick your instance.

> **The one AWS-specific cost trap**: an Elastic IP is free *only* while
> associated with a running instance. If you stop the instance (not
> terminate — just stop) and leave the address allocated but unattached, or
> attached to a stopped instance, it starts billing hourly. Since you're
> running this 24/7 anyway, this won't bite you — but don't allocate a
> second one "just in case" and forget about it.

---

## 4. Networking — one layer, not two

Oracle needs both a cloud firewall *and* a host firewall opened. AWS Security
Groups are the **only** firewall you need — Ubuntu's AMI ships with an open
host `iptables`, so there's no second layer to fight. `bootstrap.sh`
deliberately does not touch `ufw` or `iptables` for this reason; adding one
on top of the Security Group is how people lock themselves out over a single
forgotten rule.

Confirm your Security Group (**EC2 → Instances → your instance → Security
tab → security group → Inbound rules**) has exactly:

| Type | Port | Source | Purpose |
|---|---|---|---|
| SSH | 22 | *your IP*`/32` | admin access — tighten this from "My IP" if your IP changes |
| HTTP | 80 | `0.0.0.0/0` | certbot challenge + redirect to HTTPS |
| HTTPS | 443 | `0.0.0.0/0` | the app |

Nothing else needs to be open — MySQL (3306) and the API (4000) stay bound to
`127.0.0.1` and are never reachable from outside the box, enforced by
`bootstrap.sh`'s MySQL config and by nginx being the only thing listening
externally.

---

## 5. DNS

Point your domain's **A record** at the Elastic IP, at whatever registrar you
use (Namecheap, Route 53, etc.):

| Host | Value | TTL |
|---|---|---|
| `billing` | your Elastic IP | 5 min |

Confirm before continuing — certbot fails against a stale record:

```bash
dig +short billing.example.com
```

No domain yet? Skip this section and TLS (§9) — `bootstrap.sh` runs without
`DOMAIN` set and serves plain HTTP on the Elastic IP so you can verify
everything works, then add the domain and run certbot later.

---

## 6. Provision the box

SSH in, then:

```bash
sudo apt-get update && sudo apt-get install -y git
sudo mkdir -p /srv && sudo chown $USER /srv
git clone https://github.com/YOURUSER/autobilling.git /srv/autobilling
sudo DOMAIN=billing.example.com bash /srv/autobilling/deploy/aws/bootstrap.sh
# or, with no domain yet:
#   sudo bash /srv/autobilling/deploy/aws/bootstrap.sh
```

[`bootstrap.sh`](../deploy/aws/bootstrap.sh) is idempotent and installs:
system timezone `Asia/Colombo` (so `node-cron` and the backup cron agree), a
**2 GB swapfile** (not optional at 1 GB RAM — see §0), Node 22 + PM2 + log
rotation, MySQL 8 tuned for a 1 GB box (128–256 MB buffer pool, not Oracle's
several GB) and bound to loopback, a generated database password at
`/root/.autobilling-db-password`, an unprivileged `autobilling` service user,
fail2ban on SSH, unattended security upgrades, and the nginx site.

### Configure the app

```bash
sudo chown -R autobilling:autobilling /srv/autobilling
sudo -u autobilling cp /srv/autobilling/server/.env.example /srv/autobilling/server/.env
node -e "for (const k of ['JWT_ACCESS_SECRET','JWT_REFRESH_SECRET','ENCRYPTION_KEY']) console.log(k+'='+require('crypto').randomBytes(32).toString('hex'))"
sudo -u autobilling nano /srv/autobilling/server/.env
```

Generate **fresh** secrets on the server. Do not copy the ones from your Mac.

```ini
NODE_ENV=production
PORT=4000
APP_URL=https://billing.example.com
API_URL=https://billing.example.com
CORS_ORIGINS=https://billing.example.com
# COOKIE_DOMAIN stays unset — same-origin needs nothing.

DATABASE_URL="mysql://autobilling:PASSWORD_FROM_/root/.autobilling-db-password@127.0.0.1:3306/autobilling?connection_limit=5&pool_timeout=20"

JWT_ACCESS_SECRET=<64 hex>
JWT_REFRESH_SECRET=<a different 64 hex>
ENCRYPTION_KEY=<exactly 64 hex>

EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxx

STORAGE_DIR=./storage
TIMEZONE=Asia/Colombo
CRON_ENABLED=true
LOG_LEVEL=info
```

Note `connection_limit=5`, not Oracle's `10` — MySQL's own `max_connections`
is tuned down to 50 for this box, and the API shares 1 GB of RAM with MySQL,
so keep the pool modest.

```bash
sudo chmod 600 /srv/autobilling/server/.env
```

### First release

```bash
sudo -u autobilling bash /srv/autobilling/deploy/aws/deploy.sh --first-run
```

[`deploy.sh`](../deploy/aws/deploy.sh) installs dependencies, generates the
Prisma client, runs `migrate deploy` **before** restarting, builds the SPA
with an empty `VITE_API_URL`, publishes it to `/var/www/autobilling`, restarts
PM2, and refuses to report success until `/health` returns `healthy`. It caps
Node's heap (`--max-old-space-size=768`) during the build so a slow build
under swap pressure doesn't turn into a killed process.

**If the build stalls or gets killed anyway**: `free -m` to confirm swap is
active, then try building server and web in separate SSH sessions rather than
back-to-back, or temporarily `sudo systemctl stop mysql` for the duration of
`npm ci`/`vite build` (MySQL isn't needed until the migrate step) and start it
again after.

Make PM2 survive reboots:

```bash
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u autobilling --hp /home/autobilling
sudo -u autobilling pm2 save
```

---

## 7. TLS

Skip this section if you're still on IP-only access — come back once DNS (§5)
is pointed at the Elastic IP.

```bash
sudo certbot --nginx -d billing.example.com --redirect \
     -m billing@example.com --agree-tos --no-eff-email
sudo systemctl status certbot.timer     # auto-renewal, should be "active (waiting)"
```

Certbot rewrites the site file in place to add the 443 block and the HTTP
redirect. Helmet already sends HSTS with a one-year max-age when
`NODE_ENV=production`.

No idle-reclamation trap on AWS — unlike Oracle Always Free, AWS never stops
your instance for being quiet. A free **UptimeRobot** monitor on
`https://billing.example.com/health` is still worth having for genuine
downtime alerts, just not as a defensive heartbeat.

---

## 8. Email — the AWS-specific rule (and the good news)

**AWS blocks outbound TCP port 25** on new EC2 instances by default (this is
the classic-mail-relay-abuse-prevention rule, not a general SMTP block — you
can request it lifted for legitimate mail servers, but you don't need to).

That's the *whole* restriction. Unlike Oracle, **AWS does not block 465 or
587**, so both of the app's mail paths work normally here:

```
EMAIL_PROVIDER=resend       # HTTPS API on 443 — always works, use this as primary
RESEND_API_KEY=re_xxxxxxxx
```

The SMTP failover path (`Settings → Email delivery`, port 465/587 to your own
mailbox) documented in [`GOING-LIVE.md §2.4`](GOING-LIVE.md) is genuinely
usable here as a second rail, unlike on Oracle where it's unreliable.

Verify from the box itself:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api.resend.com   # expect 200/401, not a hang
```

Then Settings → Email delivery → send a test email, check spam. DNS records
for Resend are covered in [`GOING-LIVE.md §2.1`](GOING-LIVE.md).

---

## 9. Backups, offsite, with no keys on the box

### S3 bucket

**S3 → Create bucket** → name it something globally unique like
`autobilling-backups-yourcompany`, keep **Block all public access** checked.
Add a **lifecycle rule** (bucket → Management → Create lifecycle rule) to
expire objects after 90 days, so you stay well inside the 5 GB free allowance.

### IAM role — no access keys stored anywhere

**IAM → Roles → Create role** → Trusted entity: **AWS service** → Use case:
**EC2** → next → attach a policy. Don't use the broad `AmazonS3FullAccess` —
create a scoped inline policy instead:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:ListBucket"],
    "Resource": [
      "arn:aws:s3:::autobilling-backups-yourcompany",
      "arn:aws:s3:::autobilling-backups-yourcompany/*"
    ]
  }]
}
```

Name the role `autobilling-backup-role`, create it, then attach it to the
running instance: **EC2 → Instances → your instance → Actions → Security →
Modify IAM role** → select `autobilling-backup-role`.

Install the AWS CLI and schedule the backup:

```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o awscliv2.zip
unzip -q awscliv2.zip && sudo ./aws/install
sudo crontab -e
```

```cron
15 2 * * * S3_BUCKET=autobilling-backups-yourcompany /bin/bash /srv/autobilling/deploy/aws/backup.sh >> /var/log/autobilling-backup.log 2>&1
```

The IAM role attached to the instance supplies credentials automatically via
the instance metadata service — `aws s3 cp` picks them up with no config
file, no keys on disk. If you launched the instance without the role
attached, attaching it later takes effect immediately, no reboot needed.

[`backup.sh`](../deploy/aws/backup.sh) takes a `--single-transaction`
mysqldump (consistent, non-locking), verifies the gzip actually decompresses
and isn't suspiciously small, archives `storage/` weekly, uploads offsite,
and prunes to 14 days local.

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

- [ ] SSH: key-only (default on the Ubuntu AMI), Security Group port 22 restricted to your IP
- [ ] fail2ban active: `sudo fail2ban-client status sshd`
- [ ] MySQL on loopback only: `ss -ltn | grep 3306` shows `127.0.0.1:3306`
- [ ] `server/.env` is `chmod 600` and owned by `autobilling`
- [ ] API runs as `autobilling`, never root: `ps -o user= -C node`
- [ ] Unattended upgrades on: `systemctl status unattended-upgrades`
- [ ] Admin seed password changed from `ChangeMe123!` at first login
- [ ] Billing alarm set (§1)
- [ ] `sudo reboot` once, then confirm PM2, MySQL and nginx all came back by themselves

Verify from outside:

```bash
curl -sS https://billing.example.com/health
curl -sSI https://billing.example.com | grep -i strict-transport-security
curl -sS https://billing.example.com/storage/invoices/ -o /dev/null -w '%{http_code}\n'  # expect 401
```

---

## 11. Day-two operations

```bash
# Release a new version
sudo -u autobilling bash /srv/autobilling/deploy/aws/deploy.sh

# Logs
sudo -u autobilling pm2 logs autobilling-api --lines 100
sudo tail -f /var/log/nginx/autobilling.error.log

# Did this morning's pipeline run?
sudo mysql autobilling -e "SELECT jobName, runKey, status, startedAt, finishedAt FROM job_runs ORDER BY startedAt DESC LIMIT 10"

# Run a job by hand (dry run writes nothing)
cd /srv/autobilling/server && sudo -u autobilling npm run jobs:run -- generate --dry

# Resource sanity — watch this more than you would on Oracle, 1 GB is tight
htop; df -h; free -m
```

### Failure playbook

| Symptom | Cause | Fix |
|---|---|---|
| `npm ci` / `vite build` killed mid-run | OOM on 1 GB RAM | `free -m` — confirm swap active; stop MySQL during build (§6) |
| Site times out | Security Group missing 80/443 from `0.0.0.0/0` | §4 |
| SSH refused after a while | Your IP changed, Security Group only allows the old one | Update the SG rule's source to your current IP |
| DNS breaks after a stop/start | Elastic IP not associated | §3 — always use the Elastic IP, never the ephemeral one |
| Elastic IP shows a charge | Allocated but unattached, or attached to a *stopped* instance | Associate it to the running instance, or release it if unused |
| Invoices generated, none delivered | Confusing Resend (works) with SMTP direct-to-port-25 (blocked) | §8 — Resend/587/465 all fine, only 25 is blocked |
| `502 Bad Gateway` | API down or unhealthy | `pm2 logs`; `.env` validation error at boot |
| API won't boot, no useful log | env validation failed | Run `node dist/server.js` in the foreground — prints the exact bad key |
| Billing ran twice | Two API processes | `pm2 list` — there must be exactly one |
| Free tier billing appeared unexpectedly | Program expired (12mo) or credit exhausted | §1 — check Billing → Free Tier, verify budget alarm fired |

---

## 12. Adding Sillara to the same box later

1 GB leaves very little headroom compared to Oracle's 24 GB box — treat this
instance as AutoBilling-only. When Sillara needs real infrastructure, give it
its own instance rather than fighting this one for RAM; a `t3.small` (2 GB)
running both, separated the same way as the Oracle guide describes (separate
databases, separate PM2 apps, separate nginx server blocks), is the more
realistic "shared box" option if you want to stay on one — but budget for it
explicitly since a `t3.small` is outside every AWS free tier.

---

## What would ever start charging you

- The instance itself, once the 12-month window or the $200 credit runs out (§1) — set the billing alarm
- EBS beyond **30 GB** (our 20 GB leaves room)
- Data transfer out beyond **100 GB/month** (you will not get close)
- An Elastic IP that's allocated but not attached to a *running* instance
- S3 beyond **5 GB** (the 90-day lifecycle rule prevents this)
- Requesting a second instance, or resizing past `t2.micro`/`t3.micro`

Set **Billing → Budgets → $1 with an 80% alert** before you finish this
guide, not after.
