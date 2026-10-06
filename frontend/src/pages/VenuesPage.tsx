import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { apiClient } from '../lib/apiClient';

interface Venue {
  venueId: string;
  name: string;
  address: string;
  capacity: number;
}

export default function VenuesPage() {
  const { orgSlug } = useParams<{ orgSlug: string }>();
  const { data, isLoading } = useQuery({
    queryKey: ['venues', orgSlug],
    queryFn: () =>
      apiClient.get('/v1/orgs/' + orgSlug + '/venues').then((r) => r.data),
  });

  return (
    <div className="p-6" aria-label="Venues page">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Venues</h1>
        <Link
          to="new"
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          aria-label="Create new venue"
        >
          + New Venue
        </Link>
      </div>
      {isLoading && <p className="text-gray-500">Loading venues...</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {(data?.venues ?? []).map((v: Venue) => (
          <div key={v.venueId} className="bg-white rounded-lg shadow p-4">
            <h3 className="font-semibold text-lg">{v.name}</h3>
            <p className="text-sm text-gray-500 mt-1">{v.address}</p>
            <p className="text-sm font-medium mt-2">
              Capacity: {v.capacity.toLocaleString()}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
