import { Router } from 'express';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs/promises';
import { asyncHandler, ok } from '../../lib/http.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { expensiveLimiter } from '../../middleware/rateLimit.js';
import { audit } from '../../middleware/audit.js';
import { BadRequest } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { getSettings, publicSettings, updateSettings } from './settings.service.js';
import { resetTransports, sendEmail } from '../../services/email/provider.js';
import { renderTemplate } from '../../services/email/templates/index.js';

const updateSchema = z.object({
  companyName: z.string().trim().min(2).max(180).optional(),
  legalName: z.string().trim().max(180).nullable().optional(),
  billingEmail: z.string().trim().toLowerCase().email().optional(),
  replyToEmail: z.string().trim().toLowerCase().email().nullable().optional(),
  supportPhone: z.string().trim().max(40).nullable().optional(),
  addressLine1: z.string().trim().max(180).nullable().optional(),
  addressLine2: z.string().trim().max(180).nullable().optional(),
  city: z.string().trim().max(90).nullable().optional(),
  country: z.string().trim().max(90).nullable().optional(),
  taxId: z.string().trim().max(60).nullable().optional(),
  website: z.string().trim().url().max(191).nullable().optional(),

  defaultCurrency: z.string().trim().toUpperCase().length(3).optional(),
  invoicePrefix: z.string().trim().regex(/^[A-Z0-9-]{2,10}$/, 'Use 2–10 uppercase letters, digits or dashes').optional(),
  invoiceFooter: z.string().trim().max(500).nullable().optional(),
  paymentInstructions: z.string().trim().max(2000).nullable().optional(),

  reminderOffsets: z
    .array(z.number().int().min(-30).max(60))
    .min(1, 'Configure at least one reminder')
    .max(8, 'Eight reminders per invoice is already too many')
    .refine((a) => new Set(a).size === a.length, 'Reminder offsets must be unique')
    .optional(),
  finalNoticeDay: z.coerce.number().int().min(1).max(90).optional(),
  timezone: z.string().trim().max(64).optional(),
  invoiceLeadDays: z.coerce.number().int().min(0).max(30).optional(),

  emailProvider: z.enum(['resend', 'smtp']).optional(),
  smtpHost: z.string().trim().max(191).nullable().optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).nullable().optional(),
  smtpUser: z.string().trim().max(191).nullable().optional(),
  smtpPassword: z.string().max(255).optional(),
  smtpSecure: z.boolean().optional(),

  automationEnabled: z.boolean().optional(),
});

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', asyncHandler(async (_req, res) => ok(res, publicSettings(await getSettings(true)))));

settingsRouter.patch(
  '/',
  requireRole('ADMIN'),
  validate({ body: updateSchema }),
  asyncHandler(async (req, res) => {
    const before = await getSettings(true);
    const after = await updateSettings(req.body as never);
    resetTransports();
    await audit({ action: 'settings.updated', entity: 'Setting', entityId: '1', before, after, req });
    ok(res, publicSettings(after));
  }),
);

/** Base64 logo upload — small files only, no multipart dependency needed. */
settingsRouter.post(
  '/logo',
  requireRole('ADMIN'),
  validate({
    body: z.object({
      filename: z.string().regex(/\.(png|jpe?g|svg)$/i, 'Logo must be a PNG, JPG or SVG'),
      dataBase64: z.string().min(10).max(3_000_000),
    }),
  }),
  asyncHandler(async (req, res) => {
    const { filename, dataBase64 } = req.body as { filename: string; dataBase64: string };
    const buffer = Buffer.from(dataBase64.replace(/^data:[^,]+,/, ''), 'base64');
    if (buffer.length > 2 * 1024 * 1024) throw BadRequest('Logo must be under 2 MB');

    const ext = path.extname(filename).toLowerCase();
    const safeName = `logo-${Date.now()}${ext}`;
    const dir = path.join(env.STORAGE_DIR, 'branding');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safeName), buffer);

    const logoPath = `/storage/branding/${safeName}`;
    const after = await updateSettings({ logoPath } as never);
    await audit({ action: 'settings.logo_updated', entity: 'Setting', entityId: '1', after: { logoPath }, req });
    ok(res, publicSettings(after));
  }),
);

/** Send a real email through the live configuration. */
settingsRouter.post(
  '/test-email',
  requireRole('ADMIN'),
  expensiveLimiter,
  validate({ body: z.object({ to: z.string().email() }) }),
  asyncHandler(async (req, res) => {
    const settings = await getSettings();
    const rendered = renderTemplate('TEST', {
      theme: {
        companyName: settings.companyName,
        primary: '#4F46E5',
        accent: '#0EA5E9',
        supportEmail: settings.billingEmail,
        website: settings.website,
      },
      client: { companyName: 'Test recipient' },
      invoice: {
        invoiceNumber: 'INV-TEST-00001',
        periodStart: new Date(),
        periodEnd: new Date(),
        dueDate: new Date(),
        issueDate: new Date(),
        total: 0,
        currency: settings.defaultCurrency,
      },
      portalUrl: env.APP_URL,
    });

    const outcome = await sendEmail({
      to: req.body.to,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    await audit({ action: 'settings.test_email', entity: 'Setting', entityId: '1', after: outcome, req });
    ok(res, outcome);
  }),
);
