// Standalone script — loads .env itself because it never imports the app.
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import { firstPeriodStart } from '../lib/dates.js';
import { nextClientCode } from '../lib/numbering.js';

/**
 * ---------------------------------------------------------------------------
 * ONBOARD A CLIENT — one command, no UI, safe to re-run
 * ---------------------------------------------------------------------------
 * Adding the first real client through a REST client at 11pm is how a wrong
 * amount ends up in a database. This asks for exactly what a monthly
 * subscription needs, prints it back, and refuses to create a duplicate.
 *
 *   npm run add-client -- \
 *     --company "Silverline Supermarket" \
 *     --email accounts@silverline.lk \
 *     --contact "Nuwan Perera" \
 *     --phone 0771234567 \
 *     --service "POS Pro + Support" \
 *     --amount 12500 \
 *     --due-day 5 \
 *     --start 2026-08-01
 *
 * Optional: --currency LKR  --cycle MONTHLY  --tax 0  --cc a@b.com,c@d.com
 *           --city Colombo  --country "Sri Lanka"  --no-auto-send  --dry
 *
 * Nothing is emailed by this script. Invoices — and therefore emails — are
 * raised by the billing job on its own schedule, so onboarding never
 * accidentally mails a client mid-setup.
 */

const prisma = new PrismaClient();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function fail(message: string): never {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const company = arg('company');
  const email = arg('email')?.toLowerCase();
  const service = arg('service');
  const amountRaw = arg('amount');
  const dueDayRaw = arg('due-day');

  if (!company || !email || !service || !amountRaw || !dueDayRaw) {
    console.log(`
  Onboard a billing client.

  Required:
    --company "Silverline Supermarket"
    --email   accounts@silverline.lk       invoices and reminders go here
    --service "POS Pro + Support"          appears as the invoice line
    --amount  12500                        per billing cycle, tax-exclusive
    --due-day 5                            1-28, the day of the month it falls due

  Optional:
    --contact "Nuwan Perera"    --phone 0771234567
    --start 2026-08-01          first month to bill (default: this month)
    --currency LKR              --cycle MONTHLY|QUARTERLY|YEARLY
    --tax 0                     percent    --cc a@x.com,b@y.com
    --city Colombo              --country "Sri Lanka"
    --no-auto-send              create invoices but do not email them
    --dry                       print what would happen, change nothing
`);
    process.exit(1);
  }

  const amount = Number(amountRaw);
  const dueDay = Number(dueDayRaw);
  const taxRate = Number(arg('tax') ?? 0);
  const cycle = (arg('cycle') ?? 'MONTHLY').toUpperCase();
  const currency = (arg('currency') ?? 'LKR').toUpperCase();
  const dryRun = flag('dry');

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" is not a valid email address.`);
  if (!Number.isFinite(amount) || amount <= 0) fail(`Amount must be a positive number, got "${amountRaw}".`);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) {
    fail(`Due day must be a whole number 1-28 (so it exists in February), got "${dueDayRaw}".`);
  }
  if (!['MONTHLY', 'QUARTERLY', 'YEARLY'].includes(cycle)) fail(`Cycle must be MONTHLY, QUARTERLY or YEARLY.`);
  if (currency.length !== 3) fail(`Currency must be a 3-letter code like LKR or USD.`);

  const startDate = arg('start') ? new Date(`${arg('start')}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(startDate.getTime())) fail(`--start must look like 2026-08-01.`);
  const periodStart = firstPeriodStart(startDate);

  const existing = await prisma.client.findFirst({
    where: { email, deletedAt: null },
    include: { subscriptions: { where: { deletedAt: null } } },
  });

  console.log(`
  ─────────────────────────────────────────────────────────
   ${dryRun ? 'DRY RUN — nothing will be written' : 'Onboarding'}
  ─────────────────────────────────────────────────────────
   Company     ${company}
   Contact     ${arg('contact') ?? '—'}
   Email       ${email}
   Service     ${service}
   Amount      ${currency} ${amount.toLocaleString()} ${taxRate > 0 ? `+ ${taxRate}% tax` : '(no tax)'}
   Cycle       ${cycle}, due on day ${dueDay}
   First bill  ${periodStart.toISOString().slice(0, 10)}
   Auto-send   ${flag('no-auto-send') ? 'NO — invoices stay unsent' : 'yes'}
  ─────────────────────────────────────────────────────────`);

  if (existing) {
    console.log(`\n  ! A client with this email already exists: ${existing.code} — ${existing.companyName}`);
    if (existing.subscriptions.length > 0) {
      console.log(`    It already has ${existing.subscriptions.length} subscription(s). Re-running would double-bill.`);
      console.log(`    Edit it in the admin UI instead, or use a different email.\n`);
      process.exit(1);
    }
    console.log(`    It has no subscription yet — one will be added to it.\n`);
  }

  if (dryRun) {
    console.log('\n  Nothing written. Drop --dry to apply.\n');
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const client =
      existing ??
      (await tx.client.create({
        data: {
          // Same gap-free sequence the API uses — CLI-0001, CLI-0002, …
          code: await nextClientCode(tx),
          companyName: company,
          contactPerson: arg('contact') ?? null,
          email,
          ccEmails: arg('cc') ?? null,
          phone: arg('phone') ?? null,
          city: arg('city') ?? null,
          country: arg('country') ?? null,
          status: 'ACTIVE',
        },
      }));

    const subscription = await tx.subscription.create({
      data: {
        clientId: client.id,
        serviceName: service,
        amount: new Prisma.Decimal(amount),
        taxRate: new Prisma.Decimal(taxRate),
        currency,
        billingCycle: cycle as 'MONTHLY' | 'QUARTERLY' | 'YEARLY',
        dueDay,
        startDate: periodStart,
        status: 'ACTIVE',
        autoSend: !flag('no-auto-send'),
      },
    });

    return { client, subscription };
  });

  console.log(`
  ✓ Client created       ${result.client.code}  ${result.client.companyName}
  ✓ Subscription active  ${currency} ${amount.toLocaleString()} / ${cycle.toLowerCase()}

  Next — check what will be billed before anything is sent:

      npm run jobs:run -- generate --dry

  When that looks right, the nightly job raises and emails the invoice on
  its own. To do it now instead:

      npm run jobs:run -- generate
`);
}

main()
  .catch((err) => {
    console.error('\n  ✗ Failed:', err instanceof Error ? err.message : err, '\n');
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
