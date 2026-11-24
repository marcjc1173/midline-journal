import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  AuthStatus,
  BackupInfo,
  CalendarDayInfo,
  Entry,
  JournalStats,
  PasskeyItem,
  Photo,
  Prompt,
  RestoreResult,
} from './types';

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const isFormData = options.body instanceof FormData;
  const res = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  return res.json() as Promise<T>;
}

export const api = {
  // Auth
  getAuthStatus: () => request<AuthStatus>('/api/auth/status'),
  setup: (password: string, displayName: string) =>
    request<{ ok: boolean }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ password, displayName }),
    }),
  login: (password: string) =>
    request<{ ok: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  updateProfile: (displayName: string) =>
    request<{ ok: boolean; displayName: string }>('/api/auth/profile', {
      method: 'PUT',
      body: JSON.stringify({ displayName }),
    }),
  updateAutoLock: (autoLockMinutes: number, lockOnClose: boolean) =>
    request<{ ok: boolean; autoLockMinutes: number; lockOnClose: boolean }>(
      '/api/auth/auto-lock',
      {
        method: 'PUT',
        body: JSON.stringify({ autoLockMinutes, lockOnClose }),
      }
    ),

  // Passkeys
  listPasskeys: () => request<{ passkeys: PasskeyItem[] }>('/api/auth/passkeys'),
  deletePasskey: (id: string) =>
    request<{ ok: boolean }>(`/api/auth/passkeys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  registerPasskey: async (name: string) => {
    const options = await request<Parameters<typeof startRegistration>[0]['optionsJSON']>(
      '/api/auth/passkey/register/options',
      { method: 'POST' }
    );
    const attResp = await startRegistration({ optionsJSON: options });
    return request<{ ok: boolean; id: string; name: string }>(
      '/api/auth/passkey/register/verify',
      {
        method: 'POST',
        body: JSON.stringify({ response: attResp, name }),
      }
    );
  },
  loginWithPasskey: async () => {
    const options = await request<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
      '/api/auth/passkey/login/options',
      { method: 'POST' }
    );
    const asseResp = await startAuthentication({ optionsJSON: options });
    return request<{ ok: boolean }>('/api/auth/passkey/login/verify', {
      method: 'POST',
      body: JSON.stringify(asseResp),
    });
  },

  // Entries
  listEntries: (params?: {
    date?: string;
    month?: string;
    search?: string;
    tag?: string;
    mood?: string;
    limit?: number;
    offset?: number;
  }) => {
    const qs = new URLSearchParams();
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ entries: Entry[]; total: number }>(`/api/entries${suffix}`);
  },
  getEntry: (id: string) => request<{ entry: Entry }>(`/api/entries/${id}`),
  createEntry: (payload: {
    title?: string;
    content: string;
    entry_date: string;
    entry_time: string;
    mood?: string | null;
    energy?: number | null;
    prompt_id?: number | null;
    prompt_text?: string | null;
    tags?: string[];
  }) =>
    request<{ entry: Entry }>('/api/entries', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateEntry: (
    id: string,
    payload: {
      title?: string;
      content?: string;
      entry_date?: string;
      entry_time?: string;
      mood?: string | null;
      energy?: number | null;
      prompt_id?: number | null;
      prompt_text?: string | null;
      tags?: string[];
    }
  ) =>
    request<{ entry: Entry }>(`/api/entries/${id}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  deleteEntry: (id: string) =>
    request<{ ok: boolean }>(`/api/entries/${id}`, { method: 'DELETE' }),
  getCalendar: (year: number, month: number) =>
    request<{ year: number; month: number; days: Record<string, CalendarDayInfo> }>(
      `/api/entries/calendar?year=${year}&month=${month}`
    ),
  getOnThisDay: (date: string) =>
    request<{
      date: string;
      entries: Entry[];
      recentThrowback: Entry[];
      recentLabel: string;
    }>(`/api/entries/on-this-day?date=${encodeURIComponent(date)}`),
  getStats: () => request<JournalStats>('/api/entries/stats'),
  getTags: () => request<{ tags: { name: string; count: number }[] }>('/api/entries/tags'),

  // Photos
  uploadPhotos: (entryId: string, files: File[]) => {
    const formData = new FormData();
    for (const f of files) {
      formData.append('photos', f);
    }
    return request<{ photos: Photo[] }>(`/api/photos/entry/${entryId}`, {
      method: 'POST',
      body: formData,
    });
  },
  updatePhotoCaption: (photoId: string, caption: string) =>
    request<{ ok: boolean }>(`/api/photos/${photoId}`, {
      method: 'PATCH',
      body: JSON.stringify({ caption }),
    }),
  deletePhoto: (photoId: string) =>
    request<{ ok: boolean }>(`/api/photos/${photoId}`, { method: 'DELETE' }),

  // Prompts
  getTodayPrompt: (date: string, offset = 0) =>
    request<{ prompt: Prompt | null; totalPrompts?: number }>(
      `/api/prompts/today?date=${encodeURIComponent(date)}&offset=${offset}`
    ),
  listPrompts: (category?: string) => {
    const suffix = category ? `?category=${encodeURIComponent(category)}` : '';
    return request<{ prompts: Prompt[]; categories: string[] }>(`/api/prompts${suffix}`);
  },
  createPrompt: (category: string, question: string) =>
    request<{ prompt: Prompt }>('/api/prompts', {
      method: 'POST',
      body: JSON.stringify({ category, question }),
    }),
  deletePrompt: (id: number) =>
    request<{ ok: boolean }>(`/api/prompts/${id}`, { method: 'DELETE' }),

  // Backup & Restore
  getBackupInfo: () => request<BackupInfo>('/api/backup/info'),
  restoreBackup: (file: File) => {
    const formData = new FormData();
    formData.append('backup', file);
    return request<RestoreResult>('/api/backup/restore', {
      method: 'POST',
      body: formData,
    });
  },
};
