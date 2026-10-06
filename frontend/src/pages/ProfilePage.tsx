import React from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export default function ProfilePage() {
  const { user } = useAuthStore();

  return (
    <div className="p-6 max-w-2xl mx-auto" aria-label="Profile page">
      <h1 className="text-2xl font-bold mb-6">Profile</h1>
      <div className="bg-white rounded-lg shadow p-6 space-y-4">
        <div>
          <label className="text-sm font-medium text-gray-500">Name</label>
          <p className="mt-1 text-gray-900">{user?.name ?? 'N/A'}</p>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-500">Email</label>
          <p className="mt-1 text-gray-900">{user?.email ?? 'N/A'}</p>
        </div>
        <div className="pt-4 border-t">
          <Link
            to="/profile/data-export"
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            aria-label="Request GDPR data export"
          >
            Request Data Export
          </Link>
        </div>
      </div>
    </div>
  );
}
