import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient } from '../lib/apiClient';

const schema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  address: z.string().min(1, 'Address is required').max(500),
  capacity: z.coerce.number().int().min(1).max(999999),
});
type FormData = z.infer<typeof schema>;

export default function CreateVenuePage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const mutation = useMutation({
    mutationFn: (data: FormData) =>
      apiClient.post('/v1/orgs/' + orgSlug + '/venues', data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['venues', orgSlug] });
      navigate('../venues');
    },
  });

  return (
    <div className="p-6 max-w-xl mx-auto" aria-label="Create venue page">
      <h1 className="text-2xl font-bold mb-6">Create Venue</h1>
      <form onSubmit={handleSubmit((d) => mutation.mutate(d))} className="space-y-4" noValidate>
        <div>
          <label htmlFor="name" className="block text-sm font-medium text-gray-700">Venue Name</label>
          <input
            id="name"
            {...register('name')}
            className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-describedby={errors.name ? 'name-error' : undefined}
          />
          {errors.name && <p id="name-error" className="mt-1 text-sm text-red-600">{errors.name.message}</p>}
        </div>
        <div>
          <label htmlFor="address" className="block text-sm font-medium text-gray-700">Address</label>
          <textarea
            id="address"
            {...register('address')}
            rows={3}
            className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-describedby={errors.address ? 'address-error' : undefined}
          />
          {errors.address && <p id="address-error" className="mt-1 text-sm text-red-600">{errors.address.message}</p>}
        </div>
        <div>
          <label htmlFor="capacity" className="block text-sm font-medium text-gray-700">Capacity</label>
          <input
            id="capacity"
            type="number"
            {...register('capacity')}
            className="mt-1 block w-full border border-gray-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-describedby={errors.capacity ? 'capacity-error' : undefined}
          />
          {errors.capacity && <p id="capacity-error" className="mt-1 text-sm text-red-600">{errors.capacity.message}</p>}
        </div>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          aria-label="Submit create venue form"
        >
          {mutation.isPending ? 'Creating...' : 'Create Venue'}
        </button>
        {mutation.isError && (
          <p className="text-red-600 text-sm">Something went wrong. Please try again.</p>
        )}
      </form>
    </div>
  );
}
