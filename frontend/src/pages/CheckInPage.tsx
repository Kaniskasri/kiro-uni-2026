import { useState, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';

const manualSchema = z.object({
  ticketCode: z.string().min(1, 'Ticket code required'),
});
type ManualForm = z.infer<typeof manualSchema>;

interface CheckInResult {
  success: boolean;
  isDuplicate: boolean;
  originalCheckedInAt?: string;
  attendeeName?: string;
  message: string;
}

interface CheckInStats {
  checkedInCount: number;
  capacity: number;
  percentage: number;
}

export function CheckInPage() {
  const { orgSlug, eventId } = useParams<{ orgSlug: string; eventId: string }>();
  const queryClient = useQueryClient();
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [capacityFull, setCapacityFull] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery<CheckInStats>({
    queryKey: ['checkin-stats', orgId, eventId],
    queryFn: async () => {
      const res = await apiClient.get<CheckInStats>(`/orgs/${orgId}/events/${eventId}/checkins/stats`);
      return res.data;
    },
    enabled: !!orgId && !!eventId,
    refetchInterval: 10_000, // fallback polling
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<ManualForm>({ resolver: zodResolver(manualSchema) });

  const checkIn = async (ticketCode: string) => {
    setResult(null);
    try {
      const res = await apiClient.post<CheckInResult>(
        `/orgs/${orgId}/events/${eventId}/checkins`,
        { ticketCode }
      );
      setResult(res.data);
      await queryClient.invalidateQueries({ queryKey: ['checkin-stats', orgId, eventId] });
      // Check capacity
      if (stats && (stats.checkedInCount + 1) >= stats.capacity) {
        setCapacityFull(true);
      }
    } catch (err) {
      setResult({ success: false, isDuplicate: false, message: extractApiError(err) });
    }
  };

  const onManualSubmit = async (data: ManualForm) => {
    await checkIn(data.ticketCode);
    reset();
  };

  // Capacity percentage bar color
  const pct = stats?.percentage ?? 0;
  const barColor = pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-yellow-500' : 'bg-green-500';

  return (
    <div className="max-w-xl space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Check-in</h1>

      {/* Capacity full alert */}
      {capacityFull && (
        <div role="alert" aria-live="assertive"
          className="flex items-center justify-between rounded bg-red-100 border border-red-400 px-4 py-3">
          <p className="text-sm font-medium text-red-800">🚨 Event is at full capacity!</p>
          <button onClick={() => setCapacityFull(false)} aria-label="Dismiss capacity alert"
            className="text-red-600 hover:text-red-800 text-lg font-bold">×</button>
        </div>
      )}

      {/* Live attendance counter */}
      <section aria-labelledby="attendance-heading" className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 id="attendance-heading" className="text-sm font-semibold text-gray-700 mb-3">
          Live attendance
          {statsLoading && <span className="ml-2 text-xs text-gray-400">(updating…)</span>}
        </h2>
        {stats ? (
          <>
            <div className="flex items-end gap-2 mb-2">
              <span className="text-3xl font-bold text-gray-900" aria-live="polite">
                {stats.checkedInCount}
              </span>
              <span className="text-lg text-gray-500">/ {stats.capacity}</span>
              <span className="ml-auto text-sm font-medium text-gray-700">{stats.percentage.toFixed(1)}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-3" role="progressbar"
              aria-valuenow={stats.checkedInCount} aria-valuemin={0} aria-valuemax={stats.capacity}
              aria-label={`${stats.checkedInCount} of ${stats.capacity} checked in`}>
              <div className={`h-3 rounded-full transition-all ${barColor}`}
                style={{ width: `${Math.min(pct, 100)}%` }} />
            </div>
            {pct >= 90 && pct < 100 && (
              <p role="alert" className="mt-2 text-xs text-yellow-700 font-medium">⚠️ Near capacity (90%+)</p>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-400">Loading stats…</p>
        )}
      </section>

      {/* Check-in result */}
      {result && (
        <div role="alert" aria-live="polite"
          className={`rounded border px-4 py-3 text-sm ${
            result.success && !result.isDuplicate ? 'bg-green-50 border-green-300 text-green-800' :
            result.isDuplicate ? 'bg-yellow-50 border-yellow-300 text-yellow-800' :
            'bg-red-50 border-red-300 text-red-800'
          }`}>
          <p className="font-medium">
            {result.success && !result.isDuplicate ? '✓ Checked in!' :
             result.isDuplicate ? '⚠ Already checked in' : '✗ Check-in failed'}
          </p>
          <p>{result.message}</p>
          {result.isDuplicate && result.originalCheckedInAt && (
            <p className="text-xs mt-1">
              Original check-in: <time dateTime={result.originalCheckedInAt}>
                {new Date(result.originalCheckedInAt).toLocaleString()}
              </time>
            </p>
          )}
        </div>
      )}

      {/* Manual check-in form */}
      <section aria-labelledby="manual-checkin-heading" className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 id="manual-checkin-heading" className="text-sm font-semibold text-gray-700 mb-3">Manual check-in</h2>
        <form onSubmit={handleSubmit(onManualSubmit)} noValidate aria-label="Manual check-in form">
          <div className="flex gap-2">
            <div className="flex-1">
              <label htmlFor="ticketCode" className="sr-only">Ticket code</label>
              <input id="ticketCode" type="text" placeholder="Enter ticket code"
                {...register('ticketCode')} aria-invalid={!!errors.ticketCode}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {errors.ticketCode && (
                <p role="alert" className="mt-1 text-xs text-red-600">{errors.ticketCode.message}</p>
              )}
            </div>
            <button type="submit" disabled={isSubmitting}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              Check in
            </button>
          </div>
        </form>
      </section>

      {/* QR scanner placeholder — html5-qrcode would be initialized here */}
      <section aria-labelledby="qr-scanner-heading" className="bg-white rounded-lg border border-gray-200 p-4">
        <h2 id="qr-scanner-heading" className="text-sm font-semibold text-gray-700 mb-3">QR scanner</h2>
        <div id="qr-reader" className="w-full" aria-label="QR code scanner viewfinder"
          style={{ minHeight: 200, background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <p className="text-sm text-gray-400">Camera scanner (requires html5-qrcode initialization)</p>
        </div>
      </section>
    </div>
  );
}
