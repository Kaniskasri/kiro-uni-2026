import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';
import { Member, MemberRole } from '../types';

const inviteSchema = z.object({
  email: z.string().email('Invalid email'),
  role: z.enum(['Admin', 'Organizer', 'Member'] as const),
});
type InviteForm = z.infer<typeof inviteSchema>;

export function MembersPage() {
  const queryClient = useQueryClient();
  const { currentOrg, role: myRole } = useOrgStore();
  const orgId = currentOrg?.orgId ?? '';
  const [showInvite, setShowInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [csvSummary, setCsvSummary] = useState<{ accepted: number; skipped: number } | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['members', orgId],
    queryFn: async () => {
      const res = await apiClient.get<{ items: Member[] }>(`/orgs/${orgId}/members`);
      return res.data.items;
    },
    enabled: !!orgId,
  });

  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } =
    useForm<InviteForm>({ resolver: zodResolver(inviteSchema), defaultValues: { role: 'Member' } });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => apiClient.delete(`/orgs/${orgId}/members/${memberId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', orgId] }),
  });

  const roleChangeMutation = useMutation({
    mutationFn: ({ memberId, role }: { memberId: string; role: MemberRole }) =>
      apiClient.put(`/orgs/${orgId}/members/${memberId}/role`, { role }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', orgId] }),
  });

  const onInvite = async (data: InviteForm) => {
    setInviteError(null);
    try {
      await apiClient.post(`/orgs/${orgId}/invitations`, data);
      reset();
      setShowInvite(false);
    } catch (err) { setInviteError(extractApiError(err)); }
  };

  const onCsvUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCsvError(null); setCsvSummary(null);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await apiClient.post<{ accepted: number; skipped: number }>(
        `/orgs/${orgId}/invitations/bulk`, formData,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      setCsvSummary(res.data);
    } catch (err) { setCsvError(extractApiError(err)); }
  };

  const canManage = myRole === 'Owner' || myRole === 'Admin';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Members</h1>
        {canManage && (
          <button onClick={() => setShowInvite(true)}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            aria-label="Invite member">
            Invite member
          </button>
        )}
      </div>

      {/* Bulk CSV upload */}
      {canManage && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-4">
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Bulk invite via CSV</h2>
          <p className="text-xs text-gray-500 mb-3">CSV columns: email, role. Max 500 rows.</p>
          <input type="file" accept=".csv" onChange={onCsvUpload}
            aria-label="Upload CSV for bulk invitation" className="text-sm" />
          {csvError && <p role="alert" className="mt-2 text-xs text-red-600">{csvError}</p>}
          {csvSummary && (
            <p role="status" className="mt-2 text-xs text-green-700">
              Accepted: {csvSummary.accepted} · Skipped: {csvSummary.skipped}
            </p>
          )}
        </div>
      )}

      {/* Invite modal */}
      {showInvite && (
        <div role="dialog" aria-modal="true" aria-labelledby="invite-title"
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-full max-w-sm">
            <h2 id="invite-title" className="text-lg font-semibold mb-4">Invite member</h2>
            <form onSubmit={handleSubmit(onInvite)} noValidate>
              {inviteError && <div role="alert" className="mb-3 text-sm text-red-600">{inviteError}</div>}
              <div className="mb-3">
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input id="email" type="email" {...register('email')} aria-invalid={!!errors.email}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                {errors.email && <p role="alert" className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
              </div>
              <div className="mb-4">
                <label htmlFor="role" className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <select id="role" {...register('role')}
                  className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="Member">Member</option>
                  <option value="Organizer">Organizer</option>
                  <option value="Admin">Admin</option>
                </select>
              </div>
              <div className="flex gap-3">
                <button type="submit" disabled={isSubmitting}
                  className="flex-1 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  Send invitation
                </button>
                <button type="button" onClick={() => setShowInvite(false)}
                  className="rounded border border-gray-300 px-4 py-2 text-sm">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Members table */}
      {isLoading ? (
        <p className="text-sm text-gray-500" role="status">Loading members…</p>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200" aria-label="Members list">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
                <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                {canManage && <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {(data ?? []).map((m) => (
                <tr key={m.memberId}>
                  <td className="px-4 py-3 text-sm text-gray-900">{m.name}</td>
                  <td className="px-4 py-3 text-sm text-gray-500">{m.email}</td>
                  <td className="px-4 py-3">
                    {canManage && m.role !== 'Owner' ? (
                      <select
                        value={m.role}
                        onChange={(e) => roleChangeMutation.mutate({ memberId: m.memberId, role: e.target.value as MemberRole })}
                        aria-label={`Change role for ${m.name}`}
                        className="rounded border border-gray-300 px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="Member">Member</option>
                        <option value="Organizer">Organizer</option>
                        <option value="Admin">Admin</option>
                      </select>
                    ) : (
                      <span className="text-sm text-gray-700">{m.role}</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-4 py-3 text-right">
                      {m.role !== 'Owner' && (
                        <button
                          onClick={() => { if (confirm(`Remove ${m.name}?`)) removeMutation.mutate(m.memberId); }}
                          aria-label={`Remove ${m.name}`}
                          className="text-xs text-red-600 hover:underline">
                          Remove
                        </button>
                      )}
                      {m.role === 'Owner' && (
                        <span className="text-xs text-gray-400" title="Cannot remove sole owner">Owner</span>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
