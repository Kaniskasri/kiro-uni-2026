import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient, extractApiError } from '../lib/apiClient';
import { useOrgStore } from '../stores/orgStore';

const nameSchema = z.object({ name: z.string().min(3).max(100) });
type NameForm = z.infer<typeof nameSchema>;

const transferSchema = z.object({ targetMemberId: z.string().min(1, 'Select a member') });
type TransferForm = z.infer<typeof transferSchema>;

export function OrgSettingsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentOrg, role } = useOrgStore();
  const [nameError, setNameError] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [showDeactivate, setShowDeactivate] = useState(false);

  const { register: regName, handleSubmit: handleName, formState: { errors: nameErrors, isSubmitting: nameSub } } =
    useForm<NameForm>({ resolver: zodResolver(nameSchema), defaultValues: { name: currentOrg?.name ?? '' } });

  const { register: regTransfer, handleSubmit: handleTransfer, formState: { errors: transferErrors, isSubmitting: transferSub } } =
    useForm<TransferForm>({ resolver: zodResolver(transferSchema) });

  if (!currentOrg) return null;

  const saveName = async (data: NameForm) => {
    setNameError(null);
    try {
      await apiClient.put(`/orgs/${currentOrg.orgId}`, data);
      await queryClient.invalidateQueries({ queryKey: ['org'] });
    } catch (err) { setNameError(extractApiError(err)); }
  };

  const transferOwnership = async (data: TransferForm) => {
    setTransferError(null);
    try {
      await apiClient.post(`/orgs/${currentOrg.orgId}/transfer-ownership`, data);
      await queryClient.invalidateQueries({ queryKey: ['org'] });
    } catch (err) { setTransferError(extractApiError(err)); }
  };

  const deactivate = async () => {
    setDeactivateError(null);
    try {
      await apiClient.post(`/orgs/${currentOrg.orgId}/deactivate`);
      navigate('/');
    } catch (err) { setDeactivateError(extractApiError(err)); }
  };

  return (
    <div className="max-w-2xl space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Organization settings</h1>

      {/* Name */}
      <section aria-labelledby="name-heading" className="bg-white rounded-lg border border-gray-200 p-6">
        <h2 id="name-heading" className="text-lg font-semibold mb-4">Organization name</h2>
        <form onSubmit={handleName(saveName)} noValidate aria-label="Update organization name">
          {nameError && <div role="alert" className="mb-3 text-sm text-red-600">{nameError}</div>}
          <div className="flex gap-3">
            <input id="org-name" type="text" {...regName('name')} aria-invalid={!!nameErrors.name}
              className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <button type="submit" disabled={nameSub}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              Save
            </button>
          </div>
          {nameErrors.name && <p role="alert" className="mt-1 text-xs text-red-600">{nameErrors.name.message}</p>}
        </form>
      </section>

      {/* Transfer ownership — Owner only */}
      {role === 'Owner' && (
        <section aria-labelledby="transfer-heading" className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 id="transfer-heading" className="text-lg font-semibold mb-1">Transfer ownership</h2>
          <p className="text-sm text-gray-500 mb-4">Transfer your Owner role to an existing member of this organization.</p>
          <form onSubmit={handleTransfer(transferOwnership)} noValidate aria-label="Transfer ownership form">
            {transferError && <div role="alert" className="mb-3 text-sm text-red-600">{transferError}</div>}
            <div className="flex gap-3">
              <input id="targetMemberId" type="text" placeholder="Member ID" {...regTransfer('targetMemberId')}
                aria-label="Target member ID" aria-invalid={!!transferErrors.targetMemberId}
                className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
              <button type="submit" disabled={transferSub}
                className="rounded bg-yellow-600 px-4 py-2 text-sm font-medium text-white hover:bg-yellow-700 disabled:opacity-50">
                Transfer
              </button>
            </div>
            {transferErrors.targetMemberId && <p role="alert" className="mt-1 text-xs text-red-600">{transferErrors.targetMemberId.message}</p>}
          </form>
        </section>
      )}

      {/* Deactivate — Owner only */}
      {role === 'Owner' && (
        <section aria-labelledby="deactivate-heading" className="bg-white rounded-lg border border-red-200 p-6">
          <h2 id="deactivate-heading" className="text-lg font-semibold text-red-700 mb-1">Deactivate organization</h2>
          <p className="text-sm text-gray-500 mb-4">This will revoke member access. Data is retained for 90 days.</p>
          {deactivateError && <div role="alert" className="mb-3 text-sm text-red-600">{deactivateError}</div>}
          {!showDeactivate ? (
            <button onClick={() => setShowDeactivate(true)}
              className="rounded border border-red-300 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50">
              Deactivate organization
            </button>
          ) : (
            <div className="flex gap-3">
              <button onClick={deactivate} className="rounded bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
                Confirm deactivation
              </button>
              <button onClick={() => setShowDeactivate(false)} className="rounded border border-gray-300 px-4 py-2 text-sm">
                Cancel
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
