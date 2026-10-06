import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { apiClient } from '../lib/apiClient';

export default function AnalyticsPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['analytics', orgSlug],
    queryFn: () =>
      apiClient.get('/v1/orgs/' + orgSlug + '/analytics/summary').then((r) => r.data),
  });

  return (
    <div className="p-6" aria-label="Analytics page">
      <h1 className="text-2xl font-bold mb-6">Analytics</h1>
      {isLoading && <p className="text-gray-500">Loading analytics...</p>}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm text-gray-500">Total Events</p>
            <p className="text-3xl font-bold mt-1">{data.totalEvents ?? 0}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm text-gray-500">Total Members</p>
            <p className="text-3xl font-bold mt-1">{data.totalMembers ?? 0}</p>
          </div>
          <div className="bg-white rounded-lg shadow p-4">
            <p className="text-sm text-gray-500">Avg Attendance</p>
            <p className="text-3xl font-bold mt-1">{data.avgAttendance ?? 0}%</p>
          </div>
        </div>
      )}
    </div>
  );
}
