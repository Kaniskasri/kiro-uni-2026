import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../lib/apiClient';

interface Notification {
  notificationId: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => apiClient.get('/v1/me/notifications').then((r) => r.data),
  });

  const markRead = useMutation({
    mutationFn: (id: string) =>
      apiClient.put('/v1/me/notifications/' + id + '/read').then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const notifications: Notification[] = data?.notifications ?? [];
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        aria-label={`Notifications, ${unread} unread`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative p-2 rounded-full hover:bg-gray-100"
      >
        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center" aria-hidden="true">
            {unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border z-50" role="dialog" aria-label="Notifications">
          <div className="p-3 border-b font-semibold text-sm">Notifications</div>
          <ul className="max-h-80 overflow-y-auto divide-y" role="list">
            {notifications.length === 0 && (
              <li className="p-4 text-sm text-gray-500">No notifications</li>
            )}
            {notifications.map((n) => (
              <li key={n.notificationId} className={`p-3 text-sm ${n.read ? 'bg-white' : 'bg-blue-50'}`} role="listitem">
                <p className="font-medium">{n.title}</p>
                <p className="text-gray-500 text-xs mt-1">{n.body}</p>
                {!n.read && (
                  <button
                    onClick={() => markRead.mutate(n.notificationId)}
                    className="text-xs text-blue-600 mt-1 hover:underline"
                    aria-label={`Mark as read: ${n.title}`}
                  >
                    Mark as read
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
