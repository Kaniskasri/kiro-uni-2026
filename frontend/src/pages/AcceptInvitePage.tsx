import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiClient, extractApiError } from '../lib/apiClient';

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [status, setStatus] = useState<'loading' | 'success' | 'expired' | 'used' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!token) { setStatus('error'); return; }
    apiClient.post(`/invitations/accept`, { token })
      .then(() => { setStatus('success'); setTimeout(() => navigate('/login'), 2000); })
      .catch((err) => {
        const msg = extractApiError(err);
        if (msg.toLowerCase().includes('expired')) setStatus('expired');
        else if (msg.toLowerCase().includes('used') || msg.toLowerCase().includes('already')) setStatus('used');
        else { setStatus('error'); setErrorMsg(msg); }
      });
  }, [token, navigate]);

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm bg-white rounded-lg shadow p-8 text-center">
        {status === 'loading' && <p className="text-gray-600" role="status">Accepting invitation…</p>}
        {status === 'success' && (
          <div role="status" className="text-green-700">
            <p className="text-lg font-semibold">Invitation accepted!</p>
            <p className="text-sm mt-1">Redirecting you to sign in…</p>
          </div>
        )}
        {status === 'expired' && (
          <div role="alert" className="text-red-700">
            <p className="text-lg font-semibold">Invitation expired</p>
            <p className="text-sm mt-1">This invitation link has expired. Please ask for a new one.</p>
          </div>
        )}
        {status === 'used' && (
          <div role="alert" className="text-yellow-700">
            <p className="text-lg font-semibold">Already accepted</p>
            <p className="text-sm mt-1">This invitation has already been used.</p>
          </div>
        )}
        {status === 'error' && (
          <div role="alert" className="text-red-700">
            <p className="text-lg font-semibold">Something went wrong</p>
            <p className="text-sm mt-1">{errorMsg ?? 'Unable to accept invitation.'}</p>
          </div>
        )}
      </div>
    </main>
  );
}
