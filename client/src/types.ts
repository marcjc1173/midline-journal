export const MAX_PHOTOS_PER_ENTRY = 10;
export const MAX_PHOTO_SIZE_MB = 15;

export interface Photo {
  id: string;
  entry_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  caption: string;
  url: string;
  thumbUrl: string;
  created_at: string;
}

export interface Entry {
  id: string;
  title: string;
  content: string;
  entry_date: string; // YYYY-MM-DD
  entry_time: string; // HH:MM
  entry_timestamp: string;
  mood: string | null;
  energy: number | null;
  prompt_id: number | null;
  prompt_text: string | null;
  tags: string[];
  photos: Photo[];
  created_at: string;
  updated_at: string;
}

export interface Prompt {
  id: number;
  category: string;
  question: string;
  is_custom: number;
  is_active: number;
  created_at: string;
}

export interface CalendarDayInfo {
  date: string;
  count: number;
  moods: string[];
  photoCount: number;
}

export interface AuthStatus {
  setupComplete: boolean;
  authenticated: boolean;
  hasPasskeys: boolean;
  passkeyCount: number;
  displayName: string;
  autoLockMinutes: number;
  lockOnClose: boolean;
}

export interface PasskeyItem {
  id: string;
  name: string;
  device_type: string | null;
  backed_up: number;
  created_at: string;
  last_used_at: string | null;
}

export interface JournalStats {
  totalEntries: number;
  totalDays: number;
  totalPhotos: number;
  streak: number;
}

export interface BackupInfo {
  entryCount: number;
  photoCount: number;
  dbSizeBytes: number;
  uploadsSizeBytes: number;
  totalEstimatedBytes: number;
}

export interface RestoreResult {
  ok: boolean;
  entryCount: number;
  photoCount: number;
  photosRestored: number | null;
  requiresUnlock: boolean;
}

export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface GDriveConfig {
  clientId: string;
  hasClientSecret: boolean;
  folderName: string;
  hasEncryptionPassphrase: boolean;
  connected: boolean;
  accountEmail: string;
  schedule: BackupSchedule;
  retentionCount: number;
  lastBackupAt: string | null;
  lastBackupFile: string | null;
  lastBackupSize: number | null;
  lastBackupError: string | null;
  redirectUri: string;
}

export interface GDriveBackupItem {
  id: string;
  name: string;
  size: number;
  createdTime: string;
  encrypted: boolean;
}

export const MOODS = [
  { id: 'good', label: 'Good', color: '#4f9d69' },
  { id: 'steady', label: 'Steady', color: '#6b9ac4' },
  { id: 'grateful', label: 'Grateful', color: '#d9923b' },
  { id: 'stressed', label: 'Stressed', color: '#d97b48' },
  { id: 'heavy', label: 'Heavy', color: '#8f7ba6' },
  { id: 'low', label: 'Low', color: '#b55d5d' },
] as const;

export function getMoodMeta(moodId: string | null) {
  return MOODS.find((m) => m.id === moodId) || null;
}

export function getTodayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

export function getNowHm(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function formatReadableDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatShortDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatTime12h(hm: string): string {
  const [hStr, mStr] = hm.split(':');
  const h = Number(hStr);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${mStr} ${suffix}`;
}
