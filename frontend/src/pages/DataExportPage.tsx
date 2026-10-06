import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';

export default function DataExportPage() {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      apiClient.post('/v1/me/data-export').then((r) => r.data),
    onSuccess: (data: { downloadUrl: string }) => setDownloadUrl(data.downloadUrl),
  });

  return (
    <div className="p-6 max-w-xl mx-auto" aria-label="Data export page">
      <h1 className="text-2xl font-bold mb-4">Data Export</h1>
      <p className="text-gray-600 mb-6">
        Request a copy of all your personal data. You will receive a download link valid for 48 hours.
      </p>
      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending}
        className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        aria-label="Request personal data export"
      >
        {mutation.isPending ? 'Requesting...' : 'Request Export'}
      </button>
      {downloadUrl && (
        <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-md">
          <p className="text-green-700">
            Export ready!{' '}
            <a href={downloadUrl} className="underline font-medium" aria-label="Download your data export">
              Download now
            </a>
          </p>
        </div>
      )}
      {mutation.isError && (
        <p className="mt-4 text-red-600 text-sm">Something went wrong. Please try again.</p>
      )}
    </div>
  );
}
