import { useEffect, useRef, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '../stores/authStore';
import { useOrgStore } from '../stores/orgStore';

const WS_BASE_URL = import.meta.env.VITE_WS_URL ?? 'wss://ws.clois.example.com';
const MAX_BACKOFF_MS = 30_000;

export type WebSocketEvent =
  | { type: 'CHECKIN_UPDATE'; eventId: string; checkedInCount: number; capacity: number }
  | { type: 'NOTIFICATION'; notificationId: string; title: string; body: string }
  | { type: 'REPORT_READY'; reportId: string; eventId: string }
  | { type: 'CAPACITY_WARNING'; eventId: string; percentage: number }
  | { type: 'CAPACITY_FULL'; eventId: string };

export function useWebSocket() {
  const ws = useRef<WebSocket | null>(null);
  const reconnectTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffMs = useRef(1000);
  const queryClient = useQueryClient();
  const accessToken = useAuthStore((s) => s.accessToken);
  const currentOrg = useOrgStore((s) => s.currentOrg);
  const orgId = currentOrg?.orgId;

  const handleMessage = useCallback(
    (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as WebSocketEvent;
        switch (msg.type) {
          case 'CHECKIN_UPDATE':
            void queryClient.invalidateQueries({ queryKey: ['checkins', orgId, msg.eventId] });
            void queryClient.invalidateQueries({ queryKey: ['checkin-stats', orgId, msg.eventId] });
            break;
          case 'NOTIFICATION':
            void queryClient.invalidateQueries({ queryKey: ['notifications'] });
            break;
          case 'REPORT_READY':
            void queryClient.invalidateQueries({ queryKey: ['analytics', orgId, msg.eventId] });
            void queryClient.invalidateQueries({ queryKey: ['trend-report', orgId] });
            break;
          case 'CAPACITY_WARNING':
          case 'CAPACITY_FULL':
            void queryClient.invalidateQueries({ queryKey: ['events', orgId, msg.eventId] });
            break;
        }
      } catch {
        // ignore malformed messages
      }
    },
    [queryClient, orgId]
  );

  const connect = useCallback(() => {
    if (!accessToken || !orgId) return;

    const url = `${WS_BASE_URL}?token=${encodeURIComponent(accessToken)}`;
    const socket = new WebSocket(url);
    ws.current = socket;

    socket.onopen = () => {
      backoffMs.current = 1000;
    };

    socket.onmessage = handleMessage;

    socket.onclose = () => {
      ws.current = null;
      // Exponential backoff reconnect
      const delay = Math.min(backoffMs.current, MAX_BACKOFF_MS);
      backoffMs.current = Math.min(backoffMs.current * 2, MAX_BACKOFF_MS);
      reconnectTimeout.current = setTimeout(connect, delay);
    };

    socket.onerror = () => {
      socket.close();
    };
  }, [accessToken, orgId, handleMessage]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeout.current) clearTimeout(reconnectTimeout.current);
      ws.current?.close();
    };
  }, [connect]);

  return ws;
}
