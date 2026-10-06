import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { apiClient, extractApiError } from '../lib/apiClient';

const schema = z.object({
  email: z.string().email('Invalid email'),
  code: z.string().length(6, 'Code must be 6 digits').regex(/^\d+$/, 'Digits only'),
});

type Form = z.infer<typeof schema>;

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const prefillEmail = (location.state as { email?: string })?.email ?? '';
  const [apiError, setApiError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  const { register, handleSubmit, getValues, formState: { errors, isSubmitting } } =
    useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: prefillEmail } });

  const onSubmit = async (data: Form) => {
    setApiError(null);
    try {
      await apiClient.post('/auth/verify-email', data);
      navigate('/login', { state: { verified: true } });
    } catch (err) {
      setApiError(extractApiError(err));
    }
  };

  const resendCode = async () => {
    const email = getValues('email');
    try {
      await apiClient.post('/auth/resend-verification', { email });
      setResent(true);
    } catch (err) {
      setApiError(extractApiError(err));
    }
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Verify your email</h1>
        <p className="text-sm text-gray-500 mb-6">Enter the 6-digit code we sent to your email.</p>

        <form onSubmit={handleSubmit(onSubmit)} noValidate aria-label="Email verification form">
          {apiError && (
            <div role="alert" className="mb-4 rounded bg-red-50 border border-red-300 px-3 py-2 text-sm text-red-700">
              {apiError}{' '}
              <button type="button" onClick={resendCode} className="underline font-medium">Resend code</button>
            </div>
          )}
          {resent && (
            <div role="status" className="mb-4 rounded bg-green-50 border border-green-300 px-3 py-2 text-sm text-green-700">
              A new code has been sent.
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input id="email" type="email" {...register('email')}
              aria-invalid={!!errors.email}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {errors.email && <p role="alert" className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
          </div>

          <div className="mb-6">
            <label htmlFor="code" className="block text-sm font-medium text-gray-700 mb-1">Verification code</label>
            <input id="code" type="text" inputMode="numeric" maxLength={6} {...register('code')}
              aria-invalid={!!errors.code}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500" />
            {errors.code && <p role="alert" className="mt-1 text-xs text-red-600">{errors.code.message}</p>}
          </div>

          <button type="submit" disabled={isSubmitting}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">
            {isSubmitting ? 'Verifying…' : 'Verify email'}
          </button>
        </form>

        <p className="mt-4 text-center text-sm text-gray-500">
          <Link to="/login" className="text-blue-600 hover:underline">Back to sign in</Link>
        </p>
      </div>
    </main>
  );
}
