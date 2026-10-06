import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { EventStatus } from '../types';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Returns consistent Tailwind classes for event lifecycle status badges.
 * Used across all pages for uniform display.
 */
export function getStatusBadgeClass(status: EventStatus): string {
  const map: Record<EventStatus, string> = {
    Draft: 'bg-gray-100 text-gray-700 border-gray-300',
    Published: 'bg-blue-100 text-blue-700 border-blue-300',
    Open: 'bg-green-100 text-green-700 border-green-300',
    In_Progress: 'bg-yellow-100 text-yellow-700 border-yellow-300',
    Completed: 'bg-purple-100 text-purple-700 border-purple-300',
    Cancelled: 'bg-red-100 text-red-700 border-red-300',
    Archived: 'bg-slate-100 text-slate-700 border-slate-300',
  };
  return map[status] ?? 'bg-gray-100 text-gray-700 border-gray-300';
}

export function formatDatetime(isoString: string, timezone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone ?? 'UTC',
    }).format(new Date(isoString));
  } catch {
    return isoString;
  }
}

export function generateCorrelationId(): string {
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
