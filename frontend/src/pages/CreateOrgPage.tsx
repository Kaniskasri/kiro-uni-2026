import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { apiClient, extractApiError } from '../lib/apiClient';

const schema = z.object({
  name: z.string().min(3, 'At least 3 characters').max(100),
  slug: z
    .string()
    .min(3, 'At least 3 characters')
    .max(63)
    .regex(/^[a-z0-9-]+$/, 'Lowercase letters, digits, and hyphens only'),
});
type Form = z.infer<typeof schema>;

interface OrgResponse { orgId: string; slug: string }

export function CreateOrgPage() {
  const navigate = useNavigate();
  const [apiError, setApiError] = useState<string | null>(null);
  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } =
    useForm<Form>({ resolver: zodResolver(schema) });

  const name = watch('name', '');
  const autoSlug = () => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
    setValue('slug', slug, { shouldValidate: true });
  };

  const onSubmit = async (data: Form) => {
    setApiError(null);
    try {
      const res = await apiClient.post<OrgResponse>('/orgs', data);
      navigate(`/orgs/${res.data.slug}/dashboard`);
    } catch (err) {
      setApiError(extractApiError(err));
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Create organization</h1>
        <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label="Create organization form">
          {apiError && (
            <div role="alert" className="mb-4 rounded bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-700">
              {apiError}
            </div>
          )}
          <div className="mb-4">
            <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">Organization name</label>
            <input id="name" type="text" {...register('name')} onBlur={autoSlug}
              aria-invalid={!!errors.name}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {errors.name && <p role="alert" className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
          </div>
          <div className="mb-6">
            <label htmlFor="slug" className="block text-sm font-medium text-gray-700 mb-1">URL slug</label>
            <div className="flex items-center gap-1">
              <span className="text-sm text-gray-400">clois.app/orgs/</span>
              <input id="slug" type="text" {...register('slug')}
                aria-invalid={!!errors.slug}
                aria-describedby="slug-hint"
                className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <p id="slug-hint" className="mt-1 text-xs text-gray-500">Lowercase, digits, hyphens only. Cannot be changed later.</p>
            {errors.slug && <p role="alert" className="mt-1 text-xs text-red-600">{errors.slug.message}</p>}
          </div>
          <button type="submit" disabled={isSubmitting}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">
            {isSubmitting ? 'Creating…' : 'Create organization'}
          </button>
        </form>
      </div>
    </main>
  );
}
