import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import type {
  AuthStatus,
  BackupInfo,
  BackupSchedule,
  CalendarDayInfo,
  Entry,
  GDriveBackupItem,
  GDriveConfig,
  JournalStats,
  PasskeyItem,
  Photo,
  Prompt,
  RestoreResult,
} from './types';

export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

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
    let code: string | undefined;
    try {
      const data = (await res.json()) as { error?: string; code?: string };
      if (data.error) msg = data.error;
      if (data.code) code = data.code;
    } catch {
      // ignore
    }
    throw new ApiError(msg, code);
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
  downloadEncryptedBackup: async (passphrase: string) => {
    const res = await fetch('/api/backup/download', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
    });
    if (!res.ok) {
      let msg = `Download failed (${res.status})`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) msg = data.error;
      } catch {
        // ignore
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const filename =
      res.headers.get('X-Backup-Filename') || 'midline-backup.tar.gz.enc';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
  restoreBackup: (file: File, passphrase?: string) => {
    const formData = new FormData();
    formData.append('backup', file);
    if (passphrase) {
      formData.append('passphrase', passphrase);
    }
    return request<RestoreResult>('/api/backup/restore', {
      method: 'POST',
      body: formData,
    });
  },

  // Google Drive Cloud Sync
  getGDriveConfig: () => request<GDriveConfig>('/api/backup/gdrive/config'),
  saveGDriveConfig: (payload: {
    clientId?: string;
    clientSecret?: string;
    folderName?: string;
    encryptionPassphrase?: string;
    schedule?: BackupSchedule;
    retentionCount?: number;
  }) =>
    request<{ ok: boolean } & GDriveConfig>('/api/backup/gdrive/config', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  connectGDrive: () =>
    request<{ authUrl: string }>('/api/backup/gdrive/connect', { method: 'POST' }),
  disconnectGDrive: () =>
    request<{ ok: boolean }>('/api/backup/gdrive/disconnect', { method: 'POST' }),
  listGDriveBackups: () =>
    request<{ backups: GDriveBackupItem[] }>('/api/backup/gdrive/backups'),
  runGDriveBackupNow: () =>
    request<{ ok: boolean; backup: { id: string; name: string; size: number; pruned: number } }>(
      '/api/backup/gdrive/backup-now',
      { method: 'POST' }
    ),
  restoreGDriveBackup: (fileId: string, passphrase?: string) =>
    request<RestoreResult>(`/api/backup/gdrive/restore/${encodeURIComponent(fileId)}`, {
      method: 'POST',
      body: JSON.stringify(passphrase ? { passphrase } : {}),
    }),
  deleteGDriveBackup: (fileId: string) =>
    request<{ ok: boolean }>(`/api/backup/gdrive/backups/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
    }),
};
