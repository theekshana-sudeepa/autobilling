/**
 * Email layout primitives.
 *
 * Rules that keep these rendering in Outlook / Gmail / Apple Mail:
 *   • Tables for structure, never flexbox or grid.
 *   • Inline styles only — Gmail strips <style> in some clients.
 *   • Max width 600px, single column below 600px via a scoped media query.
 *   • Dark-mode-safe: explicit background AND text colour on every block.
 *   • No web fonts; system stack only.
 */

export interface BrandTheme {
  companyName: string;
  logoUrl?: string | null;
  primary: string;
  accent: string;
  supportEmail: string;
  website?: string | null;
  address?: string | null;
}

export const DEFAULT_THEME: BrandTheme = {
  companyName: 'AutoBilling',
  primary: '#4F46E5',
  accent: '#0EA5E9',
  supportEmail: 'billing@example.com',
};

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif`;

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONES: Record<Tone, { bg: string; fg: string; bar: string }> = {
  neutral: { bg: '#F1F5F9', fg: '#334155', bar: '#64748B' },
  info: { bg: '#EFF6FF', fg: '#1E40AF', bar: '#3B82F6' },
  success: { bg: '#ECFDF5', fg: '#065F46', bar: '#10B981' },
  warning: { bg: '#FFFBEB', fg: '#92400E', bar: '#F59E0B' },
  danger: { bg: '#FEF2F2', fg: '#991B1B', bar: '#EF4444' },
};

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function button(label: string, href: string, color: string): string {
  return `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr>
      <td align="center" bgcolor="${color}" style="border-radius:10px;">
        <a href="${href}" target="_blank"
           style="display:inline-block;padding:14px 32px;font-family:${FONT};font-size:15px;font-weight:600;
                  color:#ffffff;text-decoration:none;border-radius:10px;letter-spacing:.2px;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

export function calloutBar(tone: Tone, text: string): string {
  const t = TONES[tone];
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:${t.bg};border-left:4px solid ${t.bar};border-radius:6px;margin:0 0 24px;">
    <tr><td style="padding:14px 18px;font-family:${FONT};font-size:14px;line-height:21px;color:${t.fg};font-weight:500;">
      ${text}
    </td></tr>
  </table>`;
}

export interface SummaryRow {
  label: string;
  value: string;
  strong?: boolean;
  tone?: Tone;
}

export function summaryTable(rows: SummaryRow[]): string {
  const body = rows
    .map((r, i) => {
      const color = r.tone ? TONES[r.tone].fg : r.strong ? '#0F172A' : '#334155';
      const border = i === rows.length - 1 ? 'none' : '1px solid #E2E8F0';
      return `
      <tr>
        <td style="padding:12px 0;border-bottom:${border};font-family:${FONT};font-size:14px;color:#64748B;">
          ${escapeHtml(r.label)}
        </td>
        <td align="right" style="padding:12px 0;border-bottom:${border};font-family:${FONT};font-size:${
          r.strong ? '17px' : '14px'
        };font-weight:${r.strong ? '700' : '500'};color:${color};white-space:nowrap;">
          ${escapeHtml(r.value)}
        </td>
      </tr>`;
    })
    .join('');

  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:12px;margin:8px 0 4px;">
    <tr><td style="padding:8px 22px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${body}</table>
    </td></tr>
  </table>`;
}

export function renderLayout(params: {
  theme: BrandTheme;
  preheader: string;
  headline: string;
  eyebrow?: string;
  bodyHtml: string;
  footerNote?: string;
  headerTone?: Tone;
}): string {
  const { theme } = params;
  const headerColor = params.headerTone ? TONES[params.headerTone].bar : theme.primary;

  const logo = theme.logoUrl
    ? `<img src="${theme.logoUrl}" alt="${escapeHtml(theme.companyName)}" width="140"
            style="display:block;border:0;max-width:140px;height:auto;">`
    : `<span style="font-family:${FONT};font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-.4px;">
         ${escapeHtml(theme.companyName)}
       </span>`;

  return `<!doctype html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(params.headline)}</title>
<!--[if mso]><style>body,table,td{font-family:Arial,Helvetica,sans-serif !important;}</style><![endif]-->
<style>
  @media only screen and (max-width:620px){
    .wrap{width:100% !important;}
    .px{padding-left:22px !important;padding-right:22px !important;}
    .stack{display:block !important;width:100% !important;}
    h1{font-size:22px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#F1F5F9;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(params.preheader)}</div>
  <div style="display:none;max-height:0;overflow:hidden;">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#F1F5F9;">
    <tr><td align="center" style="padding:32px 12px;">

      <table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden;
                    box-shadow:0 1px 3px rgba(15,23,42,.08),0 12px 32px rgba(15,23,42,.06);">

        <!-- header -->
        <tr><td class="px" style="background:${headerColor};padding:26px 34px;">
          <table role="presentation" width="100%"><tr>
            <td align="left">${logo}</td>
            <td align="right" style="font-family:${FONT};font-size:12px;color:rgba(255,255,255,.82);font-weight:500;">
              ${escapeHtml(params.eyebrow ?? 'Billing')}
            </td>
          </tr></table>
        </td></tr>

        <!-- body -->
        <tr><td class="px" style="padding:36px 34px 8px;">
          <h1 style="margin:0 0 18px;font-family:${FONT};font-size:25px;line-height:33px;font-weight:700;
                     color:#0F172A;letter-spacing:-.5px;">${escapeHtml(params.headline)}</h1>
          ${params.bodyHtml}
        </td></tr>

        <!-- footer -->
        <tr><td class="px" style="padding:16px 34px 34px;">
          <table role="presentation" width="100%" style="border-top:1px solid #E2E8F0;">
            <tr><td style="padding-top:20px;font-family:${FONT};font-size:12px;line-height:19px;color:#94A3B8;">
              ${params.footerNote ? `<p style="margin:0 0 10px;">${params.footerNote}</p>` : ''}
              <p style="margin:0 0 6px;color:#64748B;font-weight:600;">${escapeHtml(theme.companyName)}</p>
              ${theme.address ? `<p style="margin:0 0 4px;">${escapeHtml(theme.address)}</p>` : ''}
              <p style="margin:0;">
                <a href="mailto:${theme.supportEmail}" style="color:${theme.primary};text-decoration:none;">${theme.supportEmail}</a>
                ${theme.website ? ` &nbsp;·&nbsp; <a href="${theme.website}" style="color:${theme.primary};text-decoration:none;">${escapeHtml(theme.website.replace(/^https?:\/\//, ''))}</a>` : ''}
              </p>
              <p style="margin:14px 0 0;color:#CBD5E1;font-size:11px;">
                This is an automated billing message. Replies reach our billing team.
              </p>
            </td></tr>
          </table>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export const p = (text: string): string =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:15px;line-height:24px;color:#334155;">${text}</p>`;

export const strong = (text: string): string => `<strong style="color:#0F172A;">${escapeHtml(text)}</strong>`;
