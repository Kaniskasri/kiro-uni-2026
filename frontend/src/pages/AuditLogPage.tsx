import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { apiClient } from '../lib/apiClient';

interface AuditEntry {
  timestamp: string;
  actor: string;
  operation: string;
  outcome: string;
  targetType: string;
  targetId: string;
}

export default function AuditLogPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['audit-log', orgSlug],
    queryFn: () =>
      apiClient.get('/v1/orgs/' + orgSlug + '/audit-log').then((r) => r.data),
  });

  return (
    <div className="p-6" aria-label="Audit log page">
      <h1 className="text-2xl font-bold mb-6">Audit Log</h1>
      {isLoading && <p className="text-gray-500">Loading...</p>}
      <div className="overflow-x-auto bg-white rounded-lg shadow">
        <table
          className="min-w-full divide-y divide-gray-200"
          role="table"
          aria-label="Audit log entries"
        >
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actor</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Operation</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Target</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Outcome</th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-200">
            {(data?.entries ?? []).map((e: AuditEntry, i: number) => (
              <tr key={i}>
                <td className="px-4 py-3 text-sm text-gray-900">{new Date(e.timestamp).toLocaleString()}</td>
                <td className="px-4 py-3 text-sm text-gray-600">{e.actor}</td>
                <td className="px-4 py-3 text-sm font-medium">{e.operation}</td>
                <td className="px-4 py-3 text-sm text-gray-500">{e.targetType}: {e.targetId}</td>
                <td className="px-4 py-3 text-sm">
                  <span className={e.outcome === 'success' ? 'text-green-600 font-medium' : 'text-red-600 font-medium'}>
                    {e.outcome}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
