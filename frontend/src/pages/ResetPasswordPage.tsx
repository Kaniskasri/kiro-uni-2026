import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiClient, extractApiError } from '../lib/apiClient';

const schema = z.object({
  code: z.string().min(1, 'Reset code is required'),
  email: z.string().email('Invalid email'),
  newPassword: z
    .string()
    .min(12, 'At least 12 characters')
    .regex(/[A-Z]/, 'Uppercase required')
    .regex(/[a-z]/, 'Lowercase required')
    .regex(/[0-9]/, 'Digit required')
    .regex(/[^A-Za-z0-9]/, 'Special character required'),
});
type Form = z.infer<typeof schema>;

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [apiError, setApiError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } =
    useForm<Form>({
      resolver: zodResolver(schema),
      defaultValues: { code: params.get('code') ?? '', email: params.get('email') ?? '' },
    });

  const onSubmit = async (data: Form) => {
    setApiError(null);
    try {
      await apiClient.post('/auth/reset-password', data);
      navigate('/login', { state: { passwordReset: true } });
    } catch (err) {
      setApiError(extractApiError(err));
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Set new password</h1>
        <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label="Reset password form">
          {apiError && (
            <div role="alert" className="mb-4 rounded bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-700">
              {apiError}
            </div>
          )}
          <input type="hidden" {...register('code')} />
          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input id="email" type="email" {...register('email')}
              aria-invalid={!!errors.email}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {errors.email && <p role="alert" className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
          </div>
          <div className="mb-6">
            <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">New password</label>
            <input id="newPassword" type="password" autoComplete="new-password" {...register('newPassword')}
              aria-invalid={!!errors.newPassword}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {errors.newPassword && <p role="alert" className="mt-1 text-xs text-red-600">{errors.newPassword.message}</p>}
          </div>
          <button type="submit" disabled={isSubmitting}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">
            {isSubmitting ? 'Saving…' : 'Set new password'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-500">
          <Link to="/login" className="text-blue-600 hover:underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
