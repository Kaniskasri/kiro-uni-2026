import { EventStatus } from '../types';
import { cn, getStatusBadgeClass } from '../lib/utils';

interface StatusBadgeProps {
  status: EventStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium',
        getStatusBadgeClass(status),
        className
      )}
      aria-label={`Status: ${status.replace('_', ' ')}`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}
