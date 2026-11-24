import crypto from 'node:crypto';
import fs from 'node:fs';
import { getSetting, setSetting } from '../db.js';
import { decryptSecretString, encryptSecretString } from './crypto.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

// Least-privilege scope: Midline can only access files/folders it creates itself
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface GDriveBackupItem {
  id: string;
  name: string;
  size: number;
  createdTime: string;
  encrypted: boolean;
}

export interface GDriveConfigPublic {
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
}

function getMasterSecret(): string {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) {
    return process.env.SESSION_SECRET;
  }
  let secret = getSetting('session_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', secret);
  }
  return secret;
}

function getEncryptedSetting(key: string): string {
  const raw = getSetting(key);
  if (!raw) return '';
  try {
    return decryptSecretString(raw, getMasterSecret());
  } catch {
    return '';
  }
}

function setEncryptedSetting(key: string, value: string): void {
  if (!value) {
    setSetting(key, '');
    return;
  }
  setSetting(key, encryptSecretString(value, getMasterSecret()));
}

export function getGDriveConfigPublic(): GDriveConfigPublic {
  const clientId = getSetting('gdrive_client_id') || '';
  const hasClientSecret = Boolean(getEncryptedSetting('gdrive_client_secret'));
  const folderName = getSetting('gdrive_folder_name') || 'Midline Backups';
  const hasEncryptionPassphrase = Boolean(getEncryptedSetting('gdrive_backup_passphrase'));
  const refreshToken = getEncryptedSetting('gdrive_refresh_token');
  const accountEmail = getSetting('gdrive_account_email') || '';
  const rawSchedule = getSetting('gdrive_schedule') || 'off';
  const schedule: BackupSchedule =
    rawSchedule === 'daily' || rawSchedule === 'weekly' ? rawSchedule : 'off';
  const retentionCount = Math.max(1, Math.min(30, Number(getSetting('gdrive_retention') || '7') || 7));

  return {
    clientId,
    hasClientSecret,
    folderName,
    hasEncryptionPassphrase,
    connected: Boolean(clientId && hasClientSecret && refreshToken),
    accountEmail,
    schedule,
    retentionCount,
    lastBackupAt: getSetting('gdrive_last_backup_at') || null,
    lastBackupFile: getSetting('gdrive_last_backup_file') || null,
    lastBackupSize: getSetting('gdrive_last_backup_size')
      ? Number(getSetting('gdrive_last_backup_size'))
      : null,
    lastBackupError: getSetting('gdrive_last_backup_error') || null,
  };
}

export function saveGDriveSettings(input: {
  clientId?: string;
  clientSecret?: string;
  folderName?: string;
  encryptionPassphrase?: string;
  schedule?: BackupSchedule;
  retentionCount?: number;
}): void {
  if (typeof input.clientId === 'string') {
    const trimmed = input.clientId.trim();
    const prev = getSetting('gdrive_client_id') || '';
    setSetting('gdrive_client_id', trimmed);
    if (trimmed !== prev) {
      setSetting('gdrive_folder_id', '');
    }
  }
  if (typeof input.clientSecret === 'string' && input.clientSecret.trim()) {
    setEncryptedSetting('gdrive_client_secret', input.clientSecret.trim());
  }
  if (typeof input.folderName === 'string') {
    const cleaned = input.folderName.trim().slice(0, 80) || 'Midline Backups';
    const prev = getSetting('gdrive_folder_name') || 'Midline Backups';
    setSetting('gdrive_folder_name', cleaned);
    if (cleaned !== prev) {
      setSetting('gdrive_folder_id', '');
    }
  }
  if (typeof input.encryptionPassphrase === 'string' && input.encryptionPassphrase.length > 0) {
    if (input.encryptionPassphrase.length < 4) {
      throw new Error('Encryption passphrase must be at least 4 characters.');
    }
    setEncryptedSetting('gdrive_backup_passphrase', input.encryptionPassphrase);
  }
  if (input.schedule && ['off', 'daily', 'weekly'].includes(input.schedule)) {
    setSetting('gdrive_schedule', input.schedule);
  }
  if (typeof input.retentionCount === 'number' && Number.isFinite(input.retentionCount)) {
    const clamped = Math.max(1, Math.min(30, Math.round(input.retentionCount)));
    setSetting('gdrive_retention', String(clamped));
  }
}

export function getSavedGDrivePassphrase(): string {
  return getEncryptedSetting('gdrive_backup_passphrase');
}

export function disconnectGDrive(): void {
  setEncryptedSetting('gdrive_refresh_token', '');
  setEncryptedSetting('gdrive_access_token', '');
  setSetting('gdrive_token_expiry', '');
  setSetting('gdrive_account_email', '');
  setSetting('gdrive_folder_id', '');
  setSetting('gdrive_schedule', 'off');
  setSetting('gdrive_last_backup_error', '');
}

export function recordGDriveBackupSuccess(filename: string, sizeBytes: number): void {
  setSetting('gdrive_last_backup_at', new Date().toISOString());
  setSetting('gdrive_last_backup_file', filename);
  setSetting('gdrive_last_backup_size', String(sizeBytes));
  setSetting('gdrive_last_backup_error', '');
}

export function recordGDriveBackupError(message: string): void {
  setSetting('gdrive_last_backup_error', message.slice(0, 500));
}

export function buildGDriveAuthUrl(redirectUri: string, state: string): string {
  const clientId = getSetting('gdrive_client_id') || '';
  const clientSecret = getEncryptedSetting('gdrive_client_secret');
  if (!clientId || !clientSecret) {
    throw new Error('Please save your Google Client ID and Client Secret first.');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGDriveCode(code: string, redirectUri: string): Promise<{ email: string }> {
  const clientId = getSetting('gdrive_client_id') || '';
  const clientSecret = getEncryptedSetting('gdrive_client_secret');
  if (!clientId || !clientSecret) {
    throw new Error('Google Drive client credentials are missing.');
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || 'Failed to exchange Google OAuth code.');
  }

  setEncryptedSetting('gdrive_access_token', data.access_token);
  if (data.refresh_token) {
    setEncryptedSetting('gdrive_refresh_token', data.refresh_token);
  }
  const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  setSetting('gdrive_token_expiry', String(expiresAt));
  setSetting('gdrive_folder_id', '');
  setSetting('gdrive_last_backup_error', '');

  // Fetch connected user's email for display in Settings
  let email = '';
  try {
    const aboutRes = await fetch(`${DRIVE_API_BASE}/about?fields=user(emailAddress)`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (aboutRes.ok) {
      const about = (await aboutRes.json()) as { user?: { emailAddress?: string } };
      email = about.user?.emailAddress || '';
    }
  } catch {
    // non-fatal
  }
  setSetting('gdrive_account_email', email);

  return { email };
}

export async function getValidAccessToken(): Promise<string> {
  const clientId = getSetting('gdrive_client_id') || '';
  const clientSecret = getEncryptedSetting('gdrive_client_secret');
  const refreshToken = getEncryptedSetting('gdrive_refresh_token');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Google Drive is not connected.');
  }

  const cachedToken = getEncryptedSetting('gdrive_access_token');
  const expiry = Number(getSetting('gdrive_token_expiry') || '0');
  if (cachedToken && expiry > Date.now() + 60_000) {
    return cachedToken;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description ||
        data.error ||
        'Could not refresh Google Drive token. Please reconnect Google Drive.'
    );
  }

  setEncryptedSetting('gdrive_access_token', data.access_token);
  setSetting('gdrive_token_expiry', String(Date.now() + (data.expires_in || 3600) * 1000));
  return data.access_token;
}

export async function ensureBackupFolder(accessToken: string): Promise<string> {
  const cachedId = getSetting('gdrive_folder_id');
  if (cachedId) {
    const check = await fetch(
      `${DRIVE_API_BASE}/files/${encodeURIComponent(cachedId)}?fields=id,trashed`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (check.ok) {
      const meta = (await check.json()) as { id?: string; trashed?: boolean };
      if (meta.id && !meta.trashed) return meta.id;
    }
  }

  const folderName = getSetting('gdrive_folder_name') || 'Midline Backups';
  const escaped = folderName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const q = `mimeType = 'application/vnd.google-apps.folder' and name = '${escaped}' and trashed = false`;

  const searchRes = await fetch(
    `${DRIVE_API_BASE}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (searchRes.ok) {
    const searchData = (await searchRes.json()) as { files?: { id: string }[] };
    if (searchData.files && searchData.files.length > 0) {
      const id = searchData.files[0].id;
      setSetting('gdrive_folder_id', id);
      return id;
    }
  }

  // Create folder
  const createRes = await fetch(`${DRIVE_API_BASE}/files?fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Could not create Google Drive folder: ${errText}`);
  }
  const created = (await createRes.json()) as { id: string };
  setSetting('gdrive_folder_id', created.id);
  return created.id;
}

export async function listDriveBackups(): Promise<GDriveBackupItem[]> {
  const accessToken = await getValidAccessToken();
  const folderId = await ensureBackupFolder(accessToken);

  const q = `'${folderId}' in parents and trashed = false`;
  const url = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(
    q
  )}&orderBy=createdTime desc&pageSize=50&fields=files(id,name,size,createdTime)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Could not list Google Drive backups: ${errText}`);
  }

  const data = (await res.json()) as {
    files?: { id: string; name: string; size?: string; createdTime?: string }[];
  };

  return (data.files || [])
    .filter((f) => f.name.endsWith('.tar.gz.enc') || f.name.endsWith('.tar.gz'))
    .map((f) => ({
      id: f.id,
      name: f.name,
      size: Number(f.size || '0') || 0,
      createdTime: f.createdTime || '',
      encrypted: f.name.endsWith('.enc'),
    }));
}

export async function uploadBackupToDrive(
  localFilePath: string,
  filename: string
): Promise<{ id: string; name: string; size: number }> {
  const accessToken = await getValidAccessToken();
  const folderId = await ensureBackupFolder(accessToken);
  const stat = await fs.promises.stat(localFilePath);
  const totalBytes = stat.size;
  const mimeType = filename.endsWith('.enc') ? 'application/octet-stream' : 'application/gzip';

  // Step 1: Initiate resumable upload session
  const initRes = await fetch(`${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,size`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(totalBytes),
    },
    body: JSON.stringify({
      name: filename,
      parents: [folderId],
    }),
  });

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(`Could not start Google Drive upload: ${errText}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) {
    throw new Error('Google Drive did not return a resumable upload URL.');
  }

  // Step 2: Upload in 8 MB chunks (must be multiple of 256 KB for Google resumable uploads)
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const handle = await fs.promises.open(localFilePath, 'r');
  try {
    let offset = 0;
    let finalMeta: { id: string; name: string; size?: string } | null = null;

    while (offset < totalBytes) {
      const length = Math.min(CHUNK_SIZE, totalBytes - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const slice = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      const end = offset + bytesRead - 1;

      const chunkRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': mimeType,
          'Content-Length': String(bytesRead),
          'Content-Range': `bytes ${offset}-${end}/${totalBytes}`,
        },
        body: slice,
      });

      if (chunkRes.status === 308) {
        offset += bytesRead;
        continue;
      }
      if (chunkRes.ok) {
        finalMeta = (await chunkRes.json()) as { id: string; name: string; size?: string };
        break;
      }
      const errText = await chunkRes.text();
      throw new Error(`Google Drive upload chunk failed (${chunkRes.status}): ${errText}`);
    }

    if (!finalMeta) {
      throw new Error('Google Drive upload did not complete.');
    }

    return {
      id: finalMeta.id,
      name: finalMeta.name || filename,
      size: Number(finalMeta.size || totalBytes) || totalBytes,
    };
  } finally {
    await handle.close();
  }
}

export async function downloadDriveBackup(fileId: string, destPath: string): Promise<void> {
  const accessToken = await getValidAccessToken();
  const res = await fetch(
    `${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Could not download backup from Google Drive (${res.status}): ${errText}`);
  }

  const ws = fs.createWriteStream(destPath);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        if (!ws.write(Buffer.from(value))) {
          await new Promise<void>((resolve, reject) => {
            ws.once('drain', resolve);
            ws.once('error', reject);
          });
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('finish', resolve);
      ws.end();
    });
  } catch (err) {
    ws.destroy();
    await fs.promises.unlink(destPath).catch(() => {});
    throw err;
  }
}

export async function deleteDriveBackup(fileId: string): Promise<void> {
  const accessToken = await getValidAccessToken();
  const res = await fetch(`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Could not delete Google Drive backup: ${errText}`);
  }
}

export async function pruneOldDriveBackups(retentionCount: number): Promise<number> {
  const backups = await listDriveBackups();
  if (backups.length <= retentionCount) return 0;
  const toDelete = backups.slice(retentionCount);
  let deleted = 0;
  for (const item of toDelete) {
    try {
      await deleteDriveBackup(item.id);
      deleted++;
    } catch (err) {
      console.warn('Could not prune old Google Drive backup:', item.name, err);
    }
  }
  return deleted;
}
