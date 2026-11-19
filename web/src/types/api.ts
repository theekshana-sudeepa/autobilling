export type UserRole = 'ADMIN' | 'STAFF';
export type ClientStatus = 'ACTIVE' | 'INACTIVE';
export type BillingCycle = 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
export type SubscriptionStatus = 'ACTIVE' | 'PAUSED' | 'CANCELLED';
export type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOID';
export type PaymentMethod = 'BANK_TRANSFER' | 'CASH' | 'CARD' | 'CHEQUE' | 'ONLINE' | 'OTHER';
export type EmailStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'BOUNCED' | 'CANCELLED';
export type EmailType =
  | 'INVOICE_CREATED'
  | 'REMINDER_BEFORE_7'
  | 'REMINDER_BEFORE_3'
  | 'REMINDER_DUE_TODAY'
  | 'REMINDER_OVERDUE_3'
  | 'REMINDER_OVERDUE_7'
  | 'FINAL_NOTICE'
  | 'PAYMENT_RECEIVED'
  | 'WELCOME'
  | 'TEST';

export interface Client {
  id: string;
  code: string;
  companyName: string;
  contactPerson: string | null;
  email: string;
  billingEmail: string | null;
  ccEmails: string | null;
  phone: string | null;
  whatsapp: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  country: string | null;
  taxId: string | null;
  notes: string | null;
  status: ClientStatus;
  createdAt: string;
  activeSubscriptions?: number;
  invoiceCount?: number;
  mrr?: number;
  currency?: string | null;
}

export interface Subscription {
  id: string;
  clientId: string;
  serviceName: string;
  description: string | null;
  amount: string;
  taxRate: string;
  currency: string;
  billingCycle: BillingCycle;
  dueDay: number;
  startDate: string;
  endDate: string | null;
  status: SubscriptionStatus;
  autoSend: boolean;
  lastInvoicedAt: string | null;
  client?: Pick<Client, 'id' | 'companyName' | 'code' | 'email' | 'status'>;
  nextBilling?: { periodStart: string; periodEnd: string; dueDate: string; generateOn: string } | null;
}

export interface InvoiceItem {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  lineTotal: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: string;
  currency: string;
  method: PaymentMethod;
  reference: string | null;
  paidAt: string;
  notes: string | null;
  voidedAt: string | null;
  recordedBy?: { id: string; name: string } | null;
  invoice?: { id: string; invoiceNumber: string; total: string; client: { id: string; companyName: string } };
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  subscriptionId: string | null;
  periodStart: string;
  periodEnd: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  subtotal: string;
  taxAmount: string;
  discount: string;
  total: string;
  amountPaid: string;
  status: InvoiceStatus;
  notes: string | null;
  sentAt: string | null;
  paidAt: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
  balanceDue?: number;
  client?: Client;
  subscription?: { id: string; serviceName: string } | null;
  items?: InvoiceItem[];
  payments?: Payment[];
  emailLogs?: EmailLog[];
}

export interface EmailLog {
  id: string;
  invoiceId: string | null;
  clientId: string | null;
  type: EmailType;
  status: EmailStatus;
  toEmail: string;
  subject: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  sentAt: string | null;
  createdAt: string;
  invoice?: { id: string; invoiceNumber: string } | null;
  client?: { id: string; companyName: string } | null;
}

export interface DashboardOverview {
  clients: { total: number; active: number; inactive: number; newThisMonth: number };
  mrr: { current: number; previous: number; changePct: number; currency: string };
  invoices: { paid: number; unpaid: number; overdue: number; draft: number; thisMonth: number };
  money: { collectedThisMonth: number; outstanding: number; overdueAmount: number; collectionRatePct: number };
  churn: { cancelledThisMonth: number; churnRatePct: number; note: string };
}

export interface RevenuePoint { month: string; billed: number; collected: number; outstanding: number }
export interface AgeingBucket { bucket: string; amount: number; count: number }
export interface TopClient { id: string; companyName: string; code: string; billed: number; collected: number; outstanding: number; invoiceCount: number }
export interface ActivityItem { id: string; action: string; entity: string; entityId: string | null; actor: string; actorType: string; at: string; detail: unknown }

export interface DashboardPayload {
  overview: DashboardOverview;
  revenue: RevenuePoint[];
  topClients: TopClient[];
  ageing: AgeingBucket[];
  activity: ActivityItem[];
  upcoming: Array<Pick<Invoice, 'id' | 'invoiceNumber' | 'dueDate' | 'total' | 'amountPaid' | 'currency'> & { client: { id: string; companyName: string } }>;
}

export interface AppSettings {
  companyName: string;
  legalName: string | null;
  logoPath: string | null;
  billingEmail: string;
  replyToEmail: string | null;
  supportPhone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  country: string | null;
  taxId: string | null;
  website: string | null;
  defaultCurrency: string;
  invoicePrefix: string;
  invoiceFooter: string | null;
  paymentInstructions: string | null;
  reminderOffsets: number[];
  finalNoticeDay: number;
  timezone: string;
  invoiceLeadDays: number;
  emailProvider: 'resend' | 'smtp';
  smtpHost: string | null;
  smtpPort: number | null;
  smtpUser: string | null;
  smtpSecure: boolean;
  smtpPasswordSet: boolean;
  automationEnabled: boolean;
}
