import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { apiClient, extractApiError } from '../lib/apiClient';

const schema = z.object({
  email: z.string().email('Invalid email address'),
});
type Form = z.infer<typeof schema>;

export function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const { register, handleSubmit, formState: { errors, isSubmitting } } =
    useForm<Form>({ resolver: zodResolver(schema) });

  const onSubmit = async (data: Form) => {
    setApiError(null);
    try {
      await apiClient.post('/auth/forgot-password', data);
      setSent(true);
    } catch (err) {
      setApiError(extractApiError(err));
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Reset password</h1>
        <p className="text-sm text-gray-500 mb-6">
          Enter your email and we'll send a reset link valid for 15 minutes.
        </p>

        {sent ? (
          <div role="status" className="rounded bg-green-50 border border-green-300 px-3 py-3 text-sm text-green-700">
            Check your inbox for a password reset link.
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label="Forgot password form">
            {apiError && (
              <div role="alert" className="mb-4 rounded bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-700">
                {apiError}
              </div>
            )}
            <div className="mb-4">
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email address</label>
              <input id="email" type="email" autoComplete="email" {...register('email')}
                aria-invalid={!!errors.email}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              {errors.email && <p role="alert" className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
            </div>
            <button type="submit" disabled={isSubmitting}
              className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">
              {isSubmitting ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}

        <p className="mt-4 text-center text-sm text-gray-500">
          <Link to="/login" className="text-blue-600 hover:underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
