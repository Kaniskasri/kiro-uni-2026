import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { Event } from '../types';
import { AIDescriptionPanel } from './AIDescriptionPanel';

const schema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  startAt: z.string().min(1),
  endAt: z.string().min(1),
  timezone: z.string().min(1),
  capacity: z.coerce.number().int().min(1).max(100_000),
  isVirtual: z.boolean(),
  venueAddress: z.string().optional(),
  meetingUrl: z.string().url().optional().or(z.literal('')),
}).refine((d) => new Date(d.endAt) > new Date(d.startAt), {
  message: 'End time must be after start time', path: ['endAt'],
});
type Form = z.infer<typeof schema>;

export function EditEventPage() {
  const navigate = useNavigate();
  const { eventId } = useParams<{ eventId: string }>();
  const queryClient = useQueryClient();
  const { currentOrg } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [apiError, setApiError] = useState<string | null>(null);

  const { data: event } = useQuery({
    queryKey: ['events', orgId, eventId],
    queryFn: async () => {
      const res = await apiClient.get<Event>(`/orgs/${orgId}/events/${eventId}`);
      return res.data;
    },
    enabled: !!orgId && !!eventId,
  });

  const { register, handleSubmit, setValue, watch, reset, formState: { errors, isSubmitting } } =
    useForm<Form>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (event) {
      reset({
        title: event.title,
        description: event.description ?? '',
        startAt: event.startAt.slice(0, 16),
        endAt: event.endAt.slice(0, 16),
        timezone: event.timezone,
        capacity: event.capacity,
        isVirtual: event.isVirtual,
        venueAddress: event.venueAddress ?? '',
        meetingUrl: event.meetingUrl ?? '',
      });
    }
  }, [event, reset]);

  const isVirtual = watch('isVirtual');
  const title = watch('title', event?.title ?? '');

  const onSubmit = async (data: Form) => {
    setApiError(null);
    try {
      await apiClient.put(`/orgs/${orgId}/events/${eventId}`, data);
      await queryClient.invalidateQueries({ queryKey: ['events', orgId, eventId] });
      navigate('..');
    } catch (err) { setApiError(extractApiError(err)); }
  };

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Edit event</h1>
      <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label="Edit event form">
        {apiError && <div role="alert" className="mb-4 rounded bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-700">{apiError}</div>}

        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-4 mb-4">
          <div>
            <label htmlFor="title" className="block text-sm font-medium text-gray-700 mb-1">Title *</label>
            <input id="title" type="text" {...register('title')} aria-invalid={!!errors.title}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {errors.title && <p role="alert" className="mt-1 text-xs text-red-600">{errors.title.message}</p>}
          </div>
          <div>
            <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">Description</label>
            <textarea id="description" rows={4} {...register('description')}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="startAt" className="block text-sm font-medium text-gray-700 mb-1">Start *</label>
              <input id="startAt" type="datetime-local" {...register('startAt')} aria-invalid={!!errors.startAt}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {errors.startAt && <p role="alert" className="mt-1 text-xs text-red-600">{errors.startAt.message}</p>}
            </div>
            <div>
              <label htmlFor="endAt" className="block text-sm font-medium text-gray-700 mb-1">End *</label>
              <input id="endAt" type="datetime-local" {...register('endAt')} aria-invalid={!!errors.endAt}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {errors.endAt && <p role="alert" className="mt-1 text-xs text-red-600">{errors.endAt.message}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 mb-1">Timezone</label>
              <input id="timezone" type="text" {...register('timezone')}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label htmlFor="capacity" className="block text-sm font-medium text-gray-700 mb-1">Capacity</label>
              <input id="capacity" type="number" {...register('capacity')}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input id="isVirtual" type="checkbox" {...register('isVirtual')}
              className="h-4 w-4 rounded border-gray-300" />
            <label htmlFor="isVirtual" className="text-sm font-medium text-gray-700">Virtual event</label>
          </div>
          {isVirtual ? (
            <div>
              <label htmlFor="meetingUrl" className="block text-sm font-medium text-gray-700 mb-1">Meeting URL</label>
              <input id="meetingUrl" type="url" {...register('meetingUrl')}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          ) : (
            <div>
              <label htmlFor="venueAddress" className="block text-sm font-medium text-gray-700 mb-1">Venue address</label>
              <input id="venueAddress" type="text" {...register('venueAddress')}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}
        </div>

        <div className="mb-4">
          <AIDescriptionPanel eventTitle={title} onAccept={(text) => setValue('description', text)} />
        </div>

        <div className="flex gap-3">
          <button type="submit" disabled={isSubmitting}
            className="rounded bg-blue-600 px-6 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            {isSubmitting ? 'Saving…' : 'Save changes'}
          </button>
          <button type="button" onClick={() => navigate('..')}
            className="rounded border border-gray-300 px-6 py-2 text-sm text-gray-700">
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
