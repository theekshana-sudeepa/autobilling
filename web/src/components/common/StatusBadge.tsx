import { Badge } from '@/components/ui/badge';
import { CheckCircle2, Clock, AlertTriangle, Ban, FileText, CircleDollarSign } from 'lucide-react';

type InvoiceStatus = 'DRAFT' | 'SENT' | 'PARTIALLY_PAID' | 'PAID' | 'OVERDUE' | 'VOID';

/**
 * Status is communicated three ways — colour, icon and text — so the table is
 * readable for colour-blind users and in greyscale print.
 */
const MAP: Record<InvoiceStatus, { label: string; variant: 'success' | 'warning' | 'destructive' | 'info' | 'muted'; Icon: typeof Clock }> = {
  PAID: { label: 'Paid', variant: 'success', Icon: CheckCircle2 },
  SENT: { label: 'Unpaid', variant: 'info', Icon: Clock },
  PARTIALLY_PAID: { label: 'Part paid', variant: 'warning', Icon: CircleDollarSign },
  OVERDUE: { label: 'Overdue', variant: 'destructive', Icon: AlertTriangle },
  DRAFT: { label: 'Draft', variant: 'muted', Icon: FileText },
  VOID: { label: 'Void', variant: 'muted', Icon: Ban },
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  const config = MAP[status as InvoiceStatus] ?? MAP.DRAFT;
  const { Icon } = config;
  return (
    <Badge variant={config.variant} className={className}>
      <Icon className="size-3" aria-hidden />
      {config.label}
    </Badge>
  );
}

const EMAIL_MAP: Record<string, { label: string; variant: 'success' | 'warning' | 'destructive' | 'muted' }> = {
  SENT: { label: 'Delivered', variant: 'success' },
  QUEUED: { label: 'Queued', variant: 'warning' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  BOUNCED: { label: 'Bounced', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'muted' },
};

export function EmailStatusBadge({ status }: { status: string }) {
  const c = EMAIL_MAP[status] ?? EMAIL_MAP.QUEUED!;
  return <Badge variant={c.variant}>{c.label}</Badge>;
}
