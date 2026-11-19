import { cn } from '@/lib/utils';

/**
 * A plain semantic table, not a virtualised grid.
 *
 * Real screen-reader support and native keyboard behaviour come free with
 * <table>; page sizes are capped at 100 server-side, so virtualisation would
 * buy nothing but complexity. Horizontal overflow scrolls inside the wrapper
 * so the page body never scrolls sideways on mobile.
 */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full min-w-[640px] caption-bottom text-sm', className)}>{children}</table>
    </div>
  );
}

export const THead = ({ children }: { children: React.ReactNode }) => (
  <thead className="border-b border-border bg-secondary/40">{children}</thead>
);

export const TBody = ({ children }: { children: React.ReactNode }) => (
  <tbody className="divide-y divide-border">{children}</tbody>
);

export const TR = ({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) => (
  <tr
    className={cn('transition-colors hover:bg-secondary/50', onClick && 'cursor-pointer', className)}
    onClick={onClick}
    tabIndex={onClick ? 0 : undefined}
    onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
  >
    {children}
  </tr>
);

export const TH = ({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' | 'center' }) => (
  <th
    scope="col"
    className={cn(
      'px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground',
      align === 'right' && 'text-right',
      align === 'center' && 'text-center',
      className,
    )}
  >
    {children}
  </th>
);

export const TD = ({ children, className, align }: { children?: React.ReactNode; className?: string; align?: 'right' | 'center' }) => (
  <td className={cn('px-4 py-3', align === 'right' && 'text-right', align === 'center' && 'text-center', className)}>
    {children}
  </td>
);

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pagination" className="flex flex-col items-center justify-between gap-3 border-t border-border px-4 py-3 sm:flex-row">
      <p className="tabular text-xs text-muted-foreground">
        Showing <span className="font-medium text-foreground">{from}–{to}</span> of{' '}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="h-8 rounded-lg border border-border px-3 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40"
        >
          Previous
        </button>
        <span className="tabular px-2 text-xs text-muted-foreground">{page} / {totalPages}</span>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="h-8 rounded-lg border border-border px-3 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </nav>
  );
}
