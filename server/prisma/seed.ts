// Standalone script — the app loads .env via src/config/env.ts, but this file
// never imports that, so it must load the file itself.
import 'dotenv/config';
import { PrismaClient, Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { subMonths, startOfMonth } from 'date-fns';

const prisma = new PrismaClient();

const D = (n: number) => new Prisma.Decimal(n);
const dateOnly = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

async function main(): Promise<void> {
  console.log('🌱 seeding…');

  await prisma.setting.upsert({
    where: { id: 1 },
    update: {},
    create: {
      id: 1,
      companyName: 'AutoBilling',
      legalName: 'Your Company LLC',
      billingEmail: 'billing@example.com',
      supportPhone: '+1 (555) 000-0000',
      addressLine1: '100 Main Street',
      city: 'Metropolis',
      country: 'United States',
      website: 'https://example.com',
      defaultCurrency: 'USD',
      invoicePrefix: 'INV',
      timezone: 'UTC',
      invoiceLeadDays: 7,
      reminderOffsets: [-7, -3, 0, 3, 7],
      finalNoticeDay: 14,
      paymentInstructions:
        'Bank: Example National Bank\nAccount name: Your Company LLC\nAccount no: 0000000000\nBranch: Main Branch\n\nPlease quote the invoice number as the payment reference and email the slip to billing@example.com.',
      invoiceFooter: 'Thank you for your business. Support: support@example.com · +1 (555) 000-0000',
    },
  });

  const password = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'ChangeMe123!', 12);
  await prisma.user.upsert({
    where: { email: 'admin@example.com' },
    update: {},
    create: { email: 'admin@example.com', name: 'System Administrator', role: 'ADMIN', passwordHash: password },
  });
  await prisma.user.upsert({
    where: { email: 'staff@example.com' },
    update: {},
    create: { email: 'staff@example.com', name: 'Billing Staff', role: 'STAFF', passwordHash: password },
  });

  if (process.env.SEED_DEMO !== 'true') {
    console.log('✅ base seed complete (set SEED_DEMO=true for demo clients)');
    return;
  }

  const demo = [
    { company: 'Silverline Supermarket', person: 'Nuwan Perera', email: 'accounts@silverline.lk', service: 'POS Pro + Support', amount: 12_500, dueDay: 5 },
    { company: 'Cafe Aroma', person: 'Dilini Fernando', email: 'dilini@cafearoma.lk', service: 'POS Lite', amount: 6_500, dueDay: 10 },
    { company: 'MegaMart Pvt Ltd', person: 'Ruwan Silva', email: 'finance@megamart.lk', service: 'POS Enterprise (5 lanes)', amount: 48_000, dueDay: 1 },
    { company: 'The Book Nook', person: 'Ayesha Jayawardena', email: 'hello@booknook.lk', service: 'POS Lite + Inventory', amount: 8_900, dueDay: 15 },
    { company: 'Green Grocers', person: 'Kasun Bandara', email: 'kasun@greengrocers.lk', service: 'POS Standard', amount: 9_750, dueDay: 20 },
  ];

  let seq = 0;
  for (const d of demo) {
    seq += 1;
    const client = await prisma.client.upsert({
      where: { code: `CLI-${String(seq).padStart(4, '0')}` },
      update: {},
      create: {
        code: `CLI-${String(seq).padStart(4, '0')}`,
        companyName: d.company,
        contactPerson: d.person,
        email: d.email,
        phone: `+94 7${seq} 123 456${seq}`,
        whatsapp: `+94 7${seq} 123 456${seq}`,
        addressLine1: `No. ${seq * 11}, Galle Road`,
        city: 'Colombo',
        country: 'Sri Lanka',
        status: 'ACTIVE',
        notes: 'Seeded demo client.',
      },
    });

    await prisma.subscription.create({
      data: {
        clientId: client.id,
        serviceName: d.service,
        description: 'Monthly POS licence, updates and priority support.',
        amount: D(d.amount),
        taxRate: D(0),
        currency: 'LKR',
        billingCycle: 'MONTHLY',
        dueDay: d.dueDay,
        startDate: dateOnly(startOfMonth(subMonths(new Date(), 3))),
        status: 'ACTIVE',
        autoSend: true,
      },
    });
  }

  await prisma.numberSequence.upsert({
    where: { scope_year: { scope: 'client', year: 0 } },
    update: { current: seq },
    create: { scope: 'client', year: 0, current: seq },
  });

  console.log(`✅ demo seed complete — ${demo.length} clients with active subscriptions`);
  console.log('   Run: npm run jobs:run -- generate   to produce their invoices');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
