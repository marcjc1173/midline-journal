import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Download,
  Fingerprint,
  HardDrive,
  KeyRound,
  Loader2,
  Lock,
  Moon,
  Smartphone,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { ApiError, api } from '../api';
import { GoogleDriveSyncCard } from '../components/GoogleDriveSyncCard';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import type { BackupInfo, PasskeyItem } from '../types';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const AUTO_LOCK_OPTIONS = [
  { minutes: 0, label: 'Never' },
  { minutes: 1, label: '1 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
];

export function SettingsPage() {
  const { status, refresh, markUnlocked } = useAuth();
  const { theme, setTheme } = useTheme();

  const [autoLockMinutes, setAutoLockMinutes] = useState(status?.autoLockMinutes ?? 0);
  const [lockOnClose, setLockOnClose] = useState(status?.lockOnClose ?? false);
  const [autoLockSaved, setAutoLockSaved] = useState(false);

  const [displayName, setDisplayName] = useState(status?.displayName || '');
  const [profileSaved, setProfileSaved] = useState(false);

  const [passkeys, setPasskeys] = useState<PasskeyItem[]>([]);
  const [deviceName, setDeviceName] = useState('');
  const [registering, setRegistering] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState('');
  const [passkeyErr, setPasskeyErr] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');

  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null);
  const [encryptDownload, setEncryptDownload] = useState(false);
  const [downloadPassphrase, setDownloadPassphrase] = useState('');
  const [downloadingBackup, setDownloadingBackup] = useState(false);
  const [selectedBackupFile, setSelectedBackupFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [needsRestorePassphrase, setNeedsRestorePassphrase] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [backupMsg, setBackupMsg] = useState('');
  const [backupErr, setBackupErr] = useState('');
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const loadPasskeys = useCallback(async () => {
    try {
      const res = await api.listPasskeys();
      setPasskeys(res.passkeys);
    } catch (err) {
      console.error(err);
    }
  }, []);

  const loadBackupInfo = useCallback(async () => {
    try {
      const info = await api.getBackupInfo();
      setBackupInfo(info);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadPasskeys();
    loadBackupInfo();
  }, [loadPasskeys, loadBackupInfo]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.updateProfile(displayName);
    await refresh();
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 2000);
  };

  const handleUpdateAutoLock = async (nextMinutes: number, nextLockOnClose: boolean) => {
    setAutoLockMinutes(nextMinutes);
    setLockOnClose(nextLockOnClose);
    if (nextLockOnClose) {
      markUnlocked();
    }
    await api.updateAutoLock(nextMinutes, nextLockOnClose);
    await refresh();
    setAutoLockSaved(true);
    setTimeout(() => setAutoLockSaved(false), 1800);
  };

  const handleRegisterPasskey = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasskeyMsg('');
    setPasskeyErr('');
    setRegistering(true);
    try {
      const label = deviceName.trim() || 'My Phone / Device';
      await api.registerPasskey(label);
      setDeviceName('');
      setPasskeyMsg(`Passkey "${label}" registered! You can now unlock with Face ID / fingerprint.`);
      await loadPasskeys();
      await refresh();
    } catch (err) {
      setPasskeyErr(
        err instanceof Error
          ? err.message
          : 'Could not register passkey. Passkeys require localhost or HTTPS.'
      );
    } finally {
      setRegistering(false);
    }
  };

  const handleDeletePasskey = async (pk: PasskeyItem) => {
    if (!window.confirm(`Remove passkey "${pk.name}"?`)) return;
    await api.deletePasskey(pk.id);
    await loadPasskeys();
    await refresh();
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg('');
    setPwErr('');
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setPwMsg('Password updated.');
    } catch (err) {
      setPwErr(err instanceof Error ? err.message : 'Could not update password.');
    }
  };

  const handleDownloadBackup = async () => {
    setBackupMsg('');
    setBackupErr('');
    if (!encryptDownload) {
      window.location.href = '/api/backup/download';
      return;
    }
    if (downloadPassphrase.length < 4) {
      setBackupErr('Encryption passphrase must be at least 4 characters.');
      return;
    }
    setDownloadingBackup(true);
    try {
      await api.downloadEncryptedBackup(downloadPassphrase);
      setBackupMsg('Encrypted backup downloaded (.tar.gz.enc).');
    } catch (err) {
      setBackupErr(err instanceof Error ? err.message : 'Could not download encrypted backup.');
    } finally {
      setDownloadingBackup(false);
    }
  };

  const handleRestoreFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setBackupMsg('');
    setBackupErr('');
    const file = e.target.files?.[0] || null;
    setSelectedBackupFile(file);
    setRestorePassphrase('');
    setNeedsRestorePassphrase(Boolean(file && file.name.toLowerCase().endsWith('.enc')));
  };

  const handleRestoreBackup = async () => {
    if (!selectedBackupFile) return;
    if (needsRestorePassphrase && !restorePassphrase) {
      setBackupErr('Please enter the encryption passphrase for this backup.');
      return;
    }
    const confirmed = window.confirm(
      `Restore journal from "${selectedBackupFile.name}"?\n\nThis will replace your current entries, settings, and photos with the contents of the backup. A safety copy of your current data will be saved automatically on the server.`
    );
    if (!confirmed) return;

    setBackupMsg('');
    setBackupErr('');
    setRestoring(true);
    try {
      const result = await api.restoreBackup(
        selectedBackupFile,
        restorePassphrase || undefined
      );
      setSelectedBackupFile(null);
      setRestorePassphrase('');
      setNeedsRestorePassphrase(false);
      if (restoreInputRef.current) {
        restoreInputRef.current.value = '';
      }
      const photoPart =
        result.photosRestored !== null
          ? ` and ${result.photosRestored} photo${result.photosRestored === 1 ? '' : 's'}`
          : '';
      setBackupMsg(
        `Restore complete: ${result.entryCount} entr${result.entryCount === 1 ? 'y' : 'ies'}${photoPart} restored.`
      );
      await refresh();
      await Promise.all([loadBackupInfo(), loadPasskeys()]);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSPHRASE_REQUIRED') {
        setNeedsRestorePassphrase(true);
      }
      setBackupErr(
        err instanceof Error ? err.message : 'Could not restore backup. Your current data was preserved.'
      );
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Manage phone passkeys, privacy, backups, and appearance.
        </p>
      </header>

      {/* Backup & Restore */}
      <section
        className="rounded-xl border p-5 space-y-4"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="rounded-lg p-2"
            style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <HardDrive className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Backup &amp; Restore</h2>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Download a full backup archive containing your journal database and photos, or
              restore from a previous Midline backup (.tar.gz or midline.db).
            </p>
          </div>
        </div>

        {/* Download Backup */}
        <div
          className="rounded-lg border px-4 py-3 space-y-3"
          style={{
            backgroundColor: 'var(--bg-subtle)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Download Full Backup</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {backupInfo
                  ? `${backupInfo.entryCount} entr${backupInfo.entryCount === 1 ? 'y' : 'ies'} · ${
                      backupInfo.photoCount
                    } photo${backupInfo.photoCount === 1 ? '' : 's'} · ~${formatBytes(
                      backupInfo.totalEstimatedBytes
                    )}`
                  : 'Includes all entries, prompts, settings, and photos.'}
              </div>
            </div>
            <button
              type="button"
              onClick={handleDownloadBackup}
              disabled={downloadingBackup}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-stone-950 transition hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {downloadingBackup ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {downloadingBackup
                ? 'Encrypting…'
                : encryptDownload
                ? 'Download Encrypted'
                : 'Download Backup'}
            </button>
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--text-muted)' }}>
            <input
              type="checkbox"
              checked={encryptDownload}
              onChange={(e) => {
                setEncryptDownload(e.target.checked);
                setBackupErr('');
              }}
              className="h-3.5 w-3.5 accent-amber-500"
            />
            <span>Encrypt download with passphrase (AES-256-GCM)</span>
          </label>

          {encryptDownload && (
            <input
              type="password"
              value={downloadPassphrase}
              onChange={(e) => setDownloadPassphrase(e.target.value)}
              placeholder="Backup encryption passphrase (4+ characters)"
              className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          )}
        </div>

        {/* Restore from Backup */}
        <div
          className="rounded-lg border px-4 py-3.5 space-y-3"
          style={{
            backgroundColor: 'var(--bg-subtle)',
            borderColor: 'var(--border)',
          }}
        >
          <div>
            <div className="text-sm font-medium">Restore from Backup</div>
            <div className="mt-0.5 flex items-start gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
              <span>
                Replaces your current journal with the selected backup (.tar.gz, .tar.gz.enc, or
                midline.db). A timestamped safety copy of your current data is kept automatically.
              </span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
            <input
              ref={restoreInputRef}
              type="file"
              accept=".tar.gz,.tar.gz.enc,.enc,.tgz,.gz,.db,application/gzip,application/x-gzip"
              onChange={handleRestoreFileChange}
              disabled={restoring}
              className="block w-full text-xs file:mr-3 file:rounded-lg file:border file:border-transparent file:px-3 file:py-1.5 file:text-xs file:font-medium file:cursor-pointer"
              style={{ color: 'var(--text-muted)' }}
            />
            <button
              type="button"
              onClick={handleRestoreBackup}
              disabled={!selectedBackupFile || restoring}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition disabled:opacity-40"
              style={{ borderColor: 'var(--border)' }}
            >
              {restoring ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {restoring ? 'Restoring…' : 'Restore Backup'}
            </button>
          </div>

          {selectedBackupFile && !restoring && (
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Selected: <span style={{ color: 'var(--text)' }}>{selectedBackupFile.name}</span> (
              {formatBytes(selectedBackupFile.size)})
            </div>
          )}

          {needsRestorePassphrase && selectedBackupFile && (
            <input
              type="password"
              value={restorePassphrase}
              onChange={(e) => setRestorePassphrase(e.target.value)}
              placeholder="Enter backup encryption passphrase"
              className="w-full max-w-sm rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          )}

          {backupMsg && (
            <div className="text-xs font-medium text-emerald-500">{backupMsg}</div>
          )}
          {backupErr && (
            <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
              {backupErr}
            </div>
          )}
        </div>
      </section>

      {/* Google Drive Cloud Sync (Encrypted) */}
      <GoogleDriveSyncCard
        onRestored={async () => {
          await refresh();
          await Promise.all([loadBackupInfo(), loadPasskeys()]);
        }}
      />

      {/* Passkeys (Phone Unlock) */}
      <section
        className="rounded-xl border p-5 space-y-4"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="rounded-lg p-2"
            style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <Fingerprint className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Passkey Unlock (Face ID / Touch ID / Fingerprint)</h2>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Register your phone or computer so you can unlock Midline in one tap without
              typing your password. Note: when accessing from your phone over your network,
              browsers require HTTPS (for example via Tailscale HTTPS or a reverse proxy like
              Caddy/Nginx).
            </p>
          </div>
        </div>

        <form onSubmit={handleRegisterPasskey} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Device label (e.g. iPhone, Pixel, Laptop)"
            className="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
          <button
            type="submit"
            disabled={registering}
            className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-stone-950 transition disabled:opacity-50"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            {registering ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Smartphone className="h-4 w-4" />
            )}
            Add This Device
          </button>
        </form>

        {passkeyMsg && (
          <div className="text-xs font-medium text-emerald-500">{passkeyMsg}</div>
        )}
        {passkeyErr && (
          <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
            {passkeyErr}
          </div>
        )}

        {passkeys.length > 0 && (
          <div className="space-y-2 pt-1">
            {passkeys.map((pk) => (
              <div
                key={pk.id}
                className="flex items-center justify-between rounded-lg border px-3.5 py-2.5 text-sm"
                style={{
                  backgroundColor: 'var(--bg-subtle)',
                  borderColor: 'var(--border)',
                }}
              >
                <div>
                  <div className="font-medium">{pk.name}</div>
                  <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    Added {new Date(pk.created_at + 'Z').toLocaleDateString()}
                    {pk.last_used_at
                      ? ` · Last used ${new Date(pk.last_used_at + 'Z').toLocaleDateString()}`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeletePasskey(pk)}
                  className="rounded-lg p-1.5 transition hover:opacity-80"
                  style={{ color: 'var(--text-muted)' }}
                  title="Remove passkey"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Auto-Lock */}
      <section
        className="rounded-xl border p-5 space-y-4"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div
              className="rounded-lg p-2"
              style={{ backgroundColor: 'var(--accent-soft)', color: 'var(--accent)' }}
            >
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold">Auto-Lock</h2>
              <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                Automatically lock your journal when you close the app or after a period of
                inactivity.
              </p>
            </div>
          </div>
          {autoLockSaved && (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-500">
              <Check className="h-3.5 w-3.5" />
              Saved
            </span>
          )}
        </div>

        <label
          className="flex items-center justify-between gap-3 rounded-lg border px-3.5 py-3 cursor-pointer"
          style={{
            backgroundColor: 'var(--bg-subtle)',
            borderColor: 'var(--border)',
          }}
        >
          <div>
            <div className="text-sm font-medium">Lock when browser or app closes</div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Require unlocking again whenever you reopen Midline.
            </div>
          </div>
          <input
            type="checkbox"
            checked={lockOnClose}
            onChange={(e) => handleUpdateAutoLock(autoLockMinutes, e.target.checked)}
            className="h-4 w-4 accent-amber-500"
          />
        </label>

        <div>
          <div
            className="mb-2 text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            Lock after inactivity
          </div>
          <div className="flex flex-wrap gap-1.5">
            {AUTO_LOCK_OPTIONS.map((opt) => {
              const active = autoLockMinutes === opt.minutes;
              return (
                <button
                  key={opt.minutes}
                  type="button"
                  onClick={() => handleUpdateAutoLock(opt.minutes, lockOnClose)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-medium transition"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {/* Appearance */}
      <section
        className="rounded-xl border p-5 space-y-3"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <h2 className="text-base font-semibold">Appearance</h2>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setTheme('dark')}
            className="flex items-center gap-2.5 rounded-xl border p-3.5 text-left text-sm font-medium transition"
            style={{
              borderColor: theme === 'dark' ? 'var(--accent)' : 'var(--border)',
              backgroundColor: theme === 'dark' ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <Moon className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            Dark Charcoal
          </button>
          <button
            type="button"
            onClick={() => setTheme('light')}
            className="flex items-center gap-2.5 rounded-xl border p-3.5 text-left text-sm font-medium transition"
            style={{
              borderColor: theme === 'light' ? 'var(--accent)' : 'var(--border)',
              backgroundColor: theme === 'light' ? 'var(--accent-soft)' : 'transparent',
            }}
          >
            <Sun className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            Warm Paper
          </button>
        </div>
      </section>

      {/* Profile */}
      <section
        className="rounded-xl border p-5 space-y-3"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <h2 className="text-base font-semibold">Profile</h2>
        <form onSubmit={handleSaveProfile} className="flex flex-col sm:flex-row gap-2">
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Your first name"
            className="flex-1 rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-medium"
            style={{ borderColor: 'var(--border)' }}
          >
            {profileSaved ? <Check className="h-4 w-4 text-emerald-500" /> : null}
            {profileSaved ? 'Saved' : 'Save Name'}
          </button>
        </form>
      </section>

      {/* Change Password */}
      <section
        className="rounded-xl border p-5 space-y-3"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          <h2 className="text-base font-semibold">Change Password / PIN</h2>
        </div>
        <form onSubmit={handleChangePassword} className="space-y-2.5 max-w-sm">
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Current password or PIN"
            required
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="New password or PIN (4+ characters)"
            required
            className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
          {pwMsg && <div className="text-xs font-medium text-emerald-500">{pwMsg}</div>}
          {pwErr && (
            <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
              {pwErr}
            </div>
          )}
          <button
            type="submit"
            className="rounded-lg border px-4 py-2 text-sm font-medium"
            style={{ borderColor: 'var(--border)' }}
          >
            Update Password
          </button>
        </form>
      </section>
    </div>
  );
}
