import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { NotFound } from '../../lib/errors.js';
import { formatMoney, toNumber } from '../../lib/money.js';
import { fmtDate, periodLabel } from '../../lib/dates.js';
import { getSettings } from '../../modules/settings/settings.service.js';

// A4 in points.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 48; // page margin

const INK = rgb(0.06, 0.09, 0.16); // slate-900
const MUTED = rgb(0.42, 0.47, 0.54); // slate-500
const LINE = rgb(0.89, 0.91, 0.94); // slate-200
const BRAND = rgb(0.31, 0.27, 0.9); // indigo-600
const SOFT = rgb(0.97, 0.98, 0.99); // slate-50
const DANGER = rgb(0.94, 0.27, 0.27);
const SUCCESS = rgb(0.06, 0.72, 0.51);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

interface TextOpts {
  size?: number;
  font?: PDFFont;
  color?: RGB;
  align?: 'left' | 'right' | 'center';
  maxWidth?: number;
}

function drawText(page: PDFPage, text: string, x: number, y: number, fonts: Fonts, opts: TextOpts = {}): number {
  const size = opts.size ?? 10;
  const font = opts.font ?? fonts.regular;
  const color = opts.color ?? INK;
  const width = font.widthOfTextAtSize(text, size);

  let drawX = x;
  if (opts.align === 'right') drawX = x - width;
  else if (opts.align === 'center') drawX = x - width / 2;

  page.drawText(text, { x: drawX, y, size, font, color });
  return width;
}

/** Naive greedy wrap — enough for addresses and payment instructions. */
function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

function statusBadge(page: PDFPage, x: number, y: number, status: string, fonts: Fonts): void {
  const map: Record<string, { bg: RGB; fg: RGB; label: string }> = {
    PAID: { bg: rgb(0.93, 0.99, 0.96), fg: SUCCESS, label: 'PAID' },
    OVERDUE: { bg: rgb(1, 0.95, 0.95), fg: DANGER, label: 'OVERDUE' },
    VOID: { bg: rgb(0.96, 0.96, 0.97), fg: MUTED, label: 'VOID' },
    PARTIALLY_PAID: { bg: rgb(1, 0.98, 0.92), fg: rgb(0.85, 0.47, 0.02), label: 'PART PAID' },
    SENT: { bg: rgb(0.94, 0.96, 1), fg: BRAND, label: 'UNPAID' },
    DRAFT: { bg: rgb(0.96, 0.96, 0.97), fg: MUTED, label: 'DRAFT' },
  };
  const s = map[status] ?? map.SENT!;
  const size = 8.5;
  const textW = fonts.bold.widthOfTextAtSize(s.label, size);
  const w = textW + 18;

  page.drawRectangle({ x: x - w, y: y - 4, width: w, height: 19, color: s.bg, borderColor: s.fg, borderWidth: 0.6, opacity: 1 });
  drawText(page, s.label, x - 9, y + 1.5, fonts, { size, font: fonts.bold, color: s.fg, align: 'right' });
}

export interface BuiltPdf {
  buffer: Buffer;
  filePath: string;
  hash: string;
}

/**
 * Renders the invoice with pdf-lib.
 *
 * Deliberately NOT Puppeteer: a headless Chrome per invoice costs ~300MB RSS
 * and ~1.5s, which is unworkable when the monthly cron renders 400 invoices on
 * a 2GB VPS. pdf-lib renders the same document in ~25ms with a flat memory
 * profile. Swap in Puppeteer only if marketing needs full HTML/CSS fidelity.
 */
export async function buildInvoicePdf(
  invoiceId: string,
  opts: {
    /**
     * Stamp the badge as this instead of the row's current status.
     *
     * An auto-sent invoice is created DRAFT, has its PDF built, and only then
     * is flipped to SENT by the mailer — so the attachment the client actually
     * received was stamped DRAFT. A client who thinks an invoice is a draft
     * does not pay it. The generator passes 'SENT' when it is about to email.
     */
    statusOverride?: string;
  } = {},
): Promise<BuiltPdf> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      client: true,
      items: { orderBy: { sortOrder: 'asc' } },
      payments: { where: { voidedAt: null }, orderBy: { paidAt: 'asc' } },
      subscription: { select: { serviceName: true } },
    },
  });
  if (!invoice) throw NotFound('Invoice');

  const settings = await getSettings();
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${invoice.invoiceNumber}`);
  pdf.setAuthor(settings.companyName);
  pdf.setSubject(`Invoice for ${periodLabel(invoice.periodStart, invoice.periodEnd)}`);
  pdf.setProducer('AutoBilling');
  pdf.setCreationDate(new Date());

  const fonts: Fonts = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
  };

  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const right = PAGE_W - M;
  let y = PAGE_H - M;

  // ---------------------------------------------------------------- header
  page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: BRAND });

  let logoDrawn = false;
  if (settings.logoPath) {
    try {
      const abs = path.join(env.STORAGE_DIR, settings.logoPath.replace(/^\/storage\//, ''));
      const bytes = await fs.readFile(abs);
      const img = settings.logoPath.endsWith('.jpg') || settings.logoPath.endsWith('.jpeg')
        ? await pdf.embedJpg(bytes)
        : await pdf.embedPng(bytes);
      const scaled = img.scaleToFit(150, 48);
      page.drawImage(img, { x: M, y: y - scaled.height + 8, width: scaled.width, height: scaled.height });
      logoDrawn = true;
    } catch (err) {
      logger.warn({ err }, 'invoice logo could not be embedded; falling back to wordmark');
    }
  }
  if (!logoDrawn) {
    drawText(page, settings.companyName, M, y - 12, fonts, { size: 20, font: fonts.bold, color: BRAND });
  }

  drawText(page, 'INVOICE', right, y - 10, fonts, { size: 26, font: fonts.bold, color: INK, align: 'right' });
  drawText(page, invoice.invoiceNumber, right, y - 28, fonts, { size: 11, font: fonts.bold, color: MUTED, align: 'right' });

  y -= 56;
  statusBadge(page, right, y, opts.statusOverride ?? invoice.status, fonts);

  // ------------------------------------------------------- company / client
  y -= 34;
  const colGap = 20;
  const colW = (PAGE_W - M * 2 - colGap) / 2;

  const companyLines = [
    settings.legalName || settings.companyName,
    settings.addressLine1,
    settings.addressLine2,
    [settings.city, settings.country].filter(Boolean).join(', '),
    settings.taxId ? `Tax ID: ${settings.taxId}` : null,
    settings.billingEmail,
    settings.supportPhone,
  ].filter(Boolean) as string[];

  const clientLines = [
    invoice.client.companyName,
    invoice.client.contactPerson ? `Attn: ${invoice.client.contactPerson}` : null,
    invoice.client.addressLine1,
    invoice.client.addressLine2,
    [invoice.client.city, invoice.client.country].filter(Boolean).join(', '),
    invoice.client.taxId ? `Tax ID: ${invoice.client.taxId}` : null,
    invoice.client.billingEmail || invoice.client.email,
    invoice.client.phone,
  ].filter(Boolean) as string[];

  drawText(page, 'FROM', M, y, fonts, { size: 8, font: fonts.bold, color: MUTED });
  drawText(page, 'BILL TO', M + colW + colGap, y, fonts, { size: 8, font: fonts.bold, color: MUTED });
  y -= 15;

  const blockTop = y;
  companyLines.forEach((line, i) => {
    drawText(page, line, M, blockTop - i * 13, fonts, {
      size: i === 0 ? 11 : 9.5,
      font: i === 0 ? fonts.bold : fonts.regular,
      color: i === 0 ? INK : MUTED,
    });
  });
  clientLines.forEach((line, i) => {
    drawText(page, line, M + colW + colGap, blockTop - i * 13, fonts, {
      size: i === 0 ? 11 : 9.5,
      font: i === 0 ? fonts.bold : fonts.regular,
      color: i === 0 ? INK : MUTED,
    });
  });

  y = blockTop - Math.max(companyLines.length, clientLines.length) * 13 - 22;

  // ------------------------------------------------------------ meta strip
  page.drawRectangle({ x: M, y: y - 44, width: PAGE_W - M * 2, height: 52, color: SOFT });
  const meta: [string, string][] = [
    ['Issue date', fmtDate(invoice.issueDate)],
    ['Billing period', periodLabel(invoice.periodStart, invoice.periodEnd)],
    ['Due date', fmtDate(invoice.dueDate)],
    ['Amount due', formatMoney(toNumber(invoice.total) - toNumber(invoice.amountPaid), invoice.currency)],
  ];
  const cellW = (PAGE_W - M * 2) / meta.length;
  meta.forEach(([label, value], i) => {
    const cx = M + 16 + i * cellW;
    drawText(page, label.toUpperCase(), cx, y - 12, fonts, { size: 7.5, font: fonts.bold, color: MUTED });
    drawText(page, value, cx, y - 30, fonts, {
      size: i === 3 ? 12 : 10.5,
      font: i === 3 ? fonts.bold : fonts.regular,
      color: i === 3 ? BRAND : INK,
    });
  });

  y -= 74;

  // ------------------------------------------------------------ line items
  // Columns are defined by their RIGHT edge, because every one of them except
  // the description is right-aligned money. Positioning them by left edge and
  // hoping the widths fit is what had "UNIT PRICE" printing on top of
  // "AMOUNT", and each line's unit price on top of its line total.
  // Column right-edges are derived from the WIDEST value that will actually be
  // printed in each column, not from guessed offsets. A hard-coded gap works
  // for Rs.12,500.00 and silently collides on Rs.1,250,000.00 or a longer
  // currency prefix — which is precisely how the quantity ended up printed
  // against the unit price.
  const widestOf = (values: string[], font: PDFFont, size: number): number =>
    values.reduce((max, v) => Math.max(max, font.widthOfTextAtSize(v, size)), 0);

  const priceW = Math.max(
    widestOf(invoice.items.map((i) => formatMoney(i.unitPrice, invoice.currency)), fonts.regular, 10),
    fonts.bold.widthOfTextAtSize('UNIT PRICE', 8),
  );
  const totalW = Math.max(
    widestOf(invoice.items.map((i) => formatMoney(i.lineTotal, invoice.currency)), fonts.bold, 10),
    fonts.bold.widthOfTextAtSize('AMOUNT', 8),
  );
  const qtyW = Math.max(
    widestOf(invoice.items.map((i) => toNumber(i.quantity).toString()), fonts.regular, 10),
    fonts.bold.widthOfTextAtSize('QTY', 8),
  );

  const COL_GAP = 18;
  const amountR = right - 12;
  const priceR = amountR - totalW - COL_GAP;
  const qtyR = priceR - priceW - COL_GAP;
  const descX = M + 12;
  const descW = qtyR - qtyW - COL_GAP - descX;

  page.drawRectangle({ x: M, y: y - 6, width: PAGE_W - M * 2, height: 24, color: INK });
  drawText(page, 'DESCRIPTION', descX, y + 2, fonts, { size: 8, font: fonts.bold, color: rgb(1, 1, 1) });
  drawText(page, 'QTY', qtyR, y + 2, fonts, { size: 8, font: fonts.bold, color: rgb(1, 1, 1), align: 'right' });
  drawText(page, 'UNIT PRICE', priceR, y + 2, fonts, { size: 8, font: fonts.bold, color: rgb(1, 1, 1), align: 'right' });
  drawText(page, 'AMOUNT', amountR, y + 2, fonts, { size: 8, font: fonts.bold, color: rgb(1, 1, 1), align: 'right' });

  y -= 20;

  for (const item of invoice.items) {
    const lines = wrap(item.description, fonts.regular, 10, descW);
    const rowH = Math.max(28, lines.length * 13 + 14);
    y -= rowH;

    lines.forEach((line, i) => {
      drawText(page, line, descX, y + rowH - 20 - i * 13, fonts, { size: 10, color: INK });
    });
    drawText(page, toNumber(item.quantity).toString(), qtyR, y + rowH - 20, fonts, { size: 10, color: MUTED, align: 'right' });
    drawText(page, formatMoney(item.unitPrice, invoice.currency), priceR, y + rowH - 20, fonts, { size: 10, color: MUTED, align: 'right' });
    drawText(page, formatMoney(item.lineTotal, invoice.currency), amountR, y + rowH - 20, fonts, { size: 10, font: fonts.bold, align: 'right' });

    page.drawLine({ start: { x: M, y }, end: { x: right, y }, thickness: 0.5, color: LINE });
  }

  // ---------------------------------------------------------------- totals
  y -= 18;
  const totalsX = right;
  const labelX = right - 150;

  const totalRows: [string, string, boolean][] = [
    ['Subtotal', formatMoney(invoice.subtotal, invoice.currency), false],
    ...(toNumber(invoice.discount) > 0 ? ([['Discount', `-${formatMoney(invoice.discount, invoice.currency)}`, false]] as [string, string, boolean][]) : []),
    ...(toNumber(invoice.taxAmount) > 0 ? ([['Tax', formatMoney(invoice.taxAmount, invoice.currency), false]] as [string, string, boolean][]) : []),
    ['Total', formatMoney(invoice.total, invoice.currency), true],
    ...(toNumber(invoice.amountPaid) > 0
      ? ([
          ['Paid', `-${formatMoney(invoice.amountPaid, invoice.currency)}`, false],
          ['Balance due', formatMoney(toNumber(invoice.total) - toNumber(invoice.amountPaid), invoice.currency), true],
        ] as [string, string, boolean][])
      : []),
  ];

  for (const [label, value, emphasise] of totalRows) {
    if (emphasise) {
      page.drawLine({ start: { x: labelX, y: y + 14 }, end: { x: totalsX, y: y + 14 }, thickness: 0.8, color: INK });
    }
    drawText(page, label, labelX, y, fonts, { size: emphasise ? 11 : 10, font: emphasise ? fonts.bold : fonts.regular, color: emphasise ? INK : MUTED });
    drawText(page, value, totalsX, y, fonts, { size: emphasise ? 13 : 10, font: emphasise ? fonts.bold : fonts.regular, color: emphasise ? BRAND : INK, align: 'right' });
    y -= emphasise ? 24 : 18;
  }

  // ------------------------------------------------- payment info + QR code
  y -= 16;
  const boxTop = y;
  const instructions = settings.paymentInstructions || 'Bank transfer details available on request. Please quote the invoice number as the payment reference.';
  // Leave a clear lane on the right for the QR block.
  const instrLines = wrap(instructions, fonts.regular, 9.5, PAGE_W - M * 2 - 190);
  // The box grows with its content. A fixed height meant long bank details
  // wrapped straight through the "Reference:" line underneath them.
  const boxH = Math.max(132, 40 + instrLines.length * 13 + 30);
  page.drawRectangle({ x: M, y: boxTop - boxH, width: PAGE_W - M * 2, height: boxH, color: SOFT, borderColor: LINE, borderWidth: 0.8 });

  drawText(page, 'PAYMENT INSTRUCTIONS', M + 18, boxTop - 22, fonts, { size: 8, font: fonts.bold, color: MUTED });
  instrLines.forEach((line, i) => {
    drawText(page, line, M + 18, boxTop - 40 - i * 13, fonts, { size: 9.5, color: INK });
  });

  drawText(page, `Reference: ${invoice.invoiceNumber}`, M + 18, boxTop - boxH + 14, fonts, { size: 9.5, font: fonts.bold, color: BRAND });

  // QR: deep-links to the hosted invoice. Replace with an EMV/PayHere payload
  // when an online payment gateway is wired up.
  try {
    const qrPng = await QRCode.toBuffer(`${env.APP_URL}/invoices/${invoice.id}`, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 220,
      color: { dark: '#0F172AFF', light: '#FFFFFFFF' },
    });
    const qrImage = await pdf.embedPng(qrPng);
    const qrSize = 88;
    page.drawImage(qrImage, { x: right - qrSize - 18, y: boxTop - boxH + 30, width: qrSize, height: qrSize });
    drawText(page, 'Scan to view', right - 18 - qrSize / 2, boxTop - boxH + 18, fonts, { size: 7.5, color: MUTED, align: 'center' });
  } catch (err) {
    logger.warn({ err }, 'QR generation failed — invoice rendered without it');
  }

  // ---------------------------------------------------------------- footer
  const footerY = 54;
  page.drawLine({ start: { x: M, y: footerY + 24 }, end: { x: right, y: footerY + 24 }, thickness: 0.5, color: LINE });
  if (settings.invoiceFooter) {
    // Reserve the right-hand third for the invoice-number / page meta line,
    // which is right-aligned on the same baseline.
    wrap(settings.invoiceFooter, fonts.regular, 8.5, PAGE_W - M * 2 - 230).slice(0, 2).forEach((line, i) => {
      drawText(page, line, M, footerY + 8 - i * 11, fonts, { size: 8.5, color: MUTED });
    });
  }
  drawText(page, `${invoice.invoiceNumber} · Page 1 of 1 · Generated ${fmtDate(new Date())}`, right, footerY + 8, fonts, {
    size: 8,
    color: MUTED,
    align: 'right',
  });

  // ------------------------------------------------------------- persist
  const bytes = await pdf.save();
  const buffer = Buffer.from(bytes);
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  const relDir = path.join('invoices', String(invoice.issueDate.getUTCFullYear()));
  const relPath = path.join(relDir, `${invoice.invoiceNumber}.pdf`);
  const absDir = path.join(env.STORAGE_DIR, relDir);
  await fs.mkdir(absDir, { recursive: true });
  await fs.writeFile(path.join(env.STORAGE_DIR, relPath), buffer);

  await prisma.invoice.update({ where: { id: invoice.id }, data: { pdfPath: relPath, pdfHash: hash } });

  logger.info({ invoiceId: invoice.id, bytes: buffer.length }, 'invoice pdf built');
  return { buffer, filePath: relPath, hash };
}

/**
 * Cache-aware read. The PDF is regenerated only when it is missing — an
 * invoice that has been sent must always render byte-identically to what the
 * client received, so callers that mutate an invoice must clear pdfPath.
 */
export async function getOrBuildInvoicePdf(invoiceId: string): Promise<BuiltPdf> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { pdfPath: true, pdfHash: true },
  });
  if (!invoice) throw NotFound('Invoice');

  if (invoice.pdfPath) {
    try {
      const buffer = await fs.readFile(path.join(env.STORAGE_DIR, invoice.pdfPath));
      return { buffer, filePath: invoice.pdfPath, hash: invoice.pdfHash ?? '' };
    } catch {
      logger.warn({ invoiceId }, 'cached pdf missing on disk — rebuilding');
    }
  }
  return buildInvoicePdf(invoiceId);
}

export async function invalidateInvoicePdf(invoiceId: string): Promise<void> {
  await prisma.invoice.update({ where: { id: invoiceId }, data: { pdfPath: null, pdfHash: null } });
}
