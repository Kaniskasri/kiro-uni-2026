/**
 * Typed API client wrapper.
 * - Attaches Authorization: Bearer <accessToken> automatically
 * - Silently refreshes token on 401 and retries once
 * - Adds X-Correlation-ID header for tracing
 */
import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { generateCorrelationId } from './utils';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'https://api.clois.example.com/v1';

let refreshPromise: Promise<string> | null = null;

function getAccessToken(): string | null {
  try {
    const raw = localStorage.getItem('auth-store');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { accessToken?: string } };
    return parsed?.state?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getRefreshToken(): string | null {
  try {
    const raw = localStorage.getItem('auth-store');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { refreshToken?: string } };
    return parsed?.state?.refreshToken ?? null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(): Promise<string> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error('No refresh token available');

  const response = await axios.post<{ accessToken: string }>(
    `${BASE_URL}/auth/refresh`,
    { refreshToken }
  );
  const { accessToken } = response.data;

  // Update stored token
  const raw = localStorage.getItem('auth-store');
  if (raw) {
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    if (parsed.state) {
      parsed.state.accessToken = accessToken;
      localStorage.setItem('auth-store', JSON.stringify(parsed));
    }
  }

  return accessToken;
}

const instance: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Request interceptor — attach auth + correlation headers
instance.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  config.headers['X-Correlation-ID'] = generateCorrelationId();
  return config;
});

// Response interceptor — refresh on 401, retry once
instance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retried?: boolean };
    if (error.response?.status === 401 && !originalRequest._retried) {
      originalRequest._retried = true;
      try {
        if (!refreshPromise) {
          refreshPromise = refreshAccessToken().finally(() => {
            refreshPromise = null;
          });
        }
        const newToken = await refreshPromise;
        if (originalRequest.headers) {
          (originalRequest.headers as Record<string, string>).Authorization = `Bearer ${newToken}`;
        }
        return instance(originalRequest);
      } catch {
        // Refresh failed — clear auth and redirect to login
        localStorage.removeItem('auth-store');
        window.location.href = '/login';
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

export const apiClient = instance;

export function extractApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string } | undefined;
    return data?.message ?? error.message ?? 'An unexpected error occurred';
  }
  if (error instanceof Error) return error.message;
  return 'An unexpected error occurred';
}
