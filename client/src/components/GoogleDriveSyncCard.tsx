import React, { useCallback, useEffect, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  CloudUpload,
  Copy,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unlink,
} from 'lucide-react';
import { ApiError, api } from '../api';
import type { BackupSchedule, GDriveBackupItem, GDriveConfig } from '../types';

const SCHEDULE_OPTIONS: { value: BackupSchedule; label: string }[] = [
  { value: 'off', label: 'Manual only' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

const RETENTION_OPTIONS = [3, 7, 14, 30];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface GoogleDriveSyncCardProps {
  onRestored: () => Promise<void>;
}

export function GoogleDriveSyncCard({ onRestored }: GoogleDriveSyncCardProps) {
  const [config, setConfig] = useState<GDriveConfig | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [folderName, setFolderName] = useState('Midline Backups');
  const [passphrase, setPassphrase] = useState('');

  const [showGuide, setShowGuide] = useState(false);
  const [copiedUri, setCopiedUri] = useState(false);

  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const [backups, setBackups] = useState<GDriveBackupItem[]>([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const loadBackups = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await api.listGDriveBackups();
      setBackups(res.backups);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not load Google Drive backups.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await api.getGDriveConfig();
      setConfig(cfg);
      setClientId(cfg.clientId);
      setFolderName(cfg.folderName || 'Midline Backups');
      if (cfg.connected) {
        loadBackups();
      } else {
        setBackups([]);
      }
    } catch (e) {
      console.error('Could not load Google Drive config:', e);
    }
  }, [loadBackups]);

  useEffect(() => {
    // Check OAuth redirect query params
    const params = new URLSearchParams(window.location.search);
    const gdriveStatus = params.get('gdrive');
    const gdriveError = params.get('gdrive_error');
    if (gdriveStatus === 'connected') {
      setMsg('Google Drive connected! Your cloud backups will be encrypted with AES-256-GCM.');
      window.history.replaceState({}, '', '/');
    } else if (gdriveError) {
      setErr(gdriveError);
      window.history.replaceState({}, '', '/');
    }
    loadConfig();
  }, [loadConfig]);

  const handleCopyUri = async () => {
    if (!config?.redirectUri) return;
    try {
      await navigator.clipboard.writeText(config.redirectUri);
      setCopiedUri(true);
      setTimeout(() => setCopiedUri(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleSaveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    setErr('');
    setSaving(true);
    try {
      const updated = await api.saveGDriveConfig({
        clientId,
        ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        folderName,
        ...(passphrase ? { encryptionPassphrase: passphrase } : {}),
      });
      setConfig(updated);
      setClientSecret('');
      setPassphrase('');
      setMsg('Google Drive settings saved.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save Google Drive settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    setMsg('');
    setErr('');
    setConnecting(true);
    try {
      // Save any typed credentials/passphrase before starting OAuth
      if (clientId.trim() || clientSecret.trim() || passphrase) {
        const updated = await api.saveGDriveConfig({
          clientId,
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          folderName,
          ...(passphrase ? { encryptionPassphrase: passphrase } : {}),
        });
        setConfig(updated);
        setClientSecret('');
        setPassphrase('');
      }
      const { authUrl } = await api.connectGDrive();
      window.location.href = authUrl;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start Google Drive connection.');
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Google Drive? Existing backups in your Drive will remain untouched.')) {
      return;
    }
    setMsg('');
    setErr('');
    try {
      await api.disconnectGDrive();
      await loadConfig();
      setMsg('Google Drive disconnected.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not disconnect Google Drive.');
    }
  };

  const handleScheduleChange = async (schedule: BackupSchedule, retentionCount: number) => {
    setMsg('');
    setErr('');
    try {
      const updated = await api.saveGDriveConfig({ schedule, retentionCount });
      setConfig(updated);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not update schedule.');
    }
  };

  const handleBackupNow = async () => {
    setMsg('');
    setErr('');
    setBackingUp(true);
    try {
      const res = await api.runGDriveBackupNow();
      setMsg(
        `Encrypted backup uploaded: ${res.backup.name} (${formatBytes(res.backup.size)})${
          res.backup.pruned > 0 ? ` · Pruned ${res.backup.pruned} old backup(s)` : ''
        }.`
      );
      await loadConfig();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Google Drive backup failed.');
    } finally {
      setBackingUp(false);
    }
  };

  const handleRestoreCloud = async (item: GDriveBackupItem) => {
    const confirmed = window.confirm(
      `Restore journal from Google Drive backup "${item.name}"?\n\nThis will replace your current entries, settings, and photos. A safety copy of your current data will be saved on the server first.`
    );
    if (!confirmed) return;

    setMsg('');
    setErr('');
    setRestoringId(item.id);
    try {
      const result = await api.restoreGDriveBackup(item.id);
      const photoPart =
        result.photosRestored !== null
          ? ` and ${result.photosRestored} photo${result.photosRestored === 1 ? '' : 's'}`
          : '';
      setMsg(
        `Restored ${result.entryCount} entr${result.entryCount === 1 ? 'y' : 'ies'}${photoPart} from Google Drive.`
      );
      await onRestored();
      await loadConfig();
    } catch (e) {
      if (
        e instanceof ApiError &&
        (e.code === 'PASSPHRASE_REQUIRED' || e.code === 'INVALID_PASSPHRASE')
      ) {
        const customPass = window.prompt(
          'This backup uses a different encryption passphrase. Enter the passphrase used when it was created:'
        );
        if (customPass) {
          try {
            const retryResult = await api.restoreGDriveBackup(item.id, customPass);
            setMsg(
              `Restored ${retryResult.entryCount} entr${retryResult.entryCount === 1 ? 'y' : 'ies'} from Google Drive.`
            );
            await onRestored();
            await loadConfig();
            return;
          } catch (retryErr) {
            setErr(
              retryErr instanceof Error
                ? retryErr.message
                : 'Could not decrypt and restore Google Drive backup.'
            );
            return;
          }
        }
      }
      setErr(e instanceof Error ? e.message : 'Could not restore from Google Drive.');
    } finally {
      setRestoringId(null);
    }
  };

  const handleDeleteCloud = async (item: GDriveBackupItem) => {
    if (!window.confirm(`Delete "${item.name}" from Google Drive?`)) return;
    setMsg('');
    setErr('');
    try {
      await api.deleteGDriveBackup(item.id);
      await loadBackups();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not delete backup from Google Drive.');
    }
  };

  return (
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
            <Cloud className="h-5 w-5" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">Google Drive Cloud Sync</h2>
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{
                  backgroundColor: config?.connected
                    ? 'rgba(16, 185, 129, 0.14)'
                    : 'var(--bg-subtle)',
                  color: config?.connected ? '#10b981' : 'var(--text-muted)',
                }}
              >
                <Lock className="h-3 w-3" />
                {config?.connected
                  ? `Connected${config.accountEmail ? ` · ${config.accountEmail}` : ''}`
                  : 'AES-256 Encrypted'}
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              Automatically encrypt and sync your journal + photos to a private folder in your
              Google Drive. Midline only requests access to files it creates itself (
              <code>drive.file</code>).
            </p>
          </div>
        </div>
      </div>

      {/* Collapsible one-time setup instructions */}
      <div
        className="rounded-lg border"
        style={{
          backgroundColor: 'var(--bg-subtle)',
          borderColor: 'var(--border)',
        }}
      >
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-medium"
        >
          <span>One-time Google Cloud setup guide (takes ~3 minutes)</span>
          {showGuide ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>
        {showGuide && (
          <div
            className="border-t px-3.5 py-3 text-xs leading-relaxed space-y-2"
            style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
          >
            <ol className="list-decimal list-inside space-y-1.5">
              <li>
                Open{' '}
                <a
                  href="https://console.cloud.google.com/apis/library/drive.googleapis.com"
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                  style={{ color: 'var(--accent)' }}
                >
                  Google Cloud Console
                </a>
                , create a project (e.g. <em>Midline Backup</em>), and enable the{' '}
                <strong>Google Drive API</strong>.
              </li>
              <li>
                Under <strong>APIs &amp; Services → OAuth consent screen</strong>, choose{' '}
                <strong>External</strong>, enter your app name, and add your Gmail address under{' '}
                <strong>Test users</strong>.
              </li>
              <li>
                Under <strong>Credentials → Create Credentials → OAuth client ID</strong>, choose{' '}
                <strong>Web application</strong> and add this exact{' '}
                <strong>Authorized redirect URI</strong>:
              </li>
            </ol>
            {config?.redirectUri && (
              <div className="flex items-center gap-2 pt-0.5">
                <code
                  className="flex-1 truncate rounded border px-2.5 py-1.5 text-[11px]"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                >
                  {config.redirectUri}
                </code>
                <button
                  type="button"
                  onClick={handleCopyUri}
                  className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
                  style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                >
                  {copiedUri ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                  {copiedUri ? 'Copied' : 'Copy'}
                </button>
              </div>
            )}
            <p>
              4. Paste your <strong>Client ID</strong> and <strong>Client Secret</strong> below,
              choose an <strong>Encryption Passphrase</strong>, and click{' '}
              <strong>Connect Google Drive</strong>.
            </p>
          </div>
        )}
      </div>

      {/* Credentials & Encryption Passphrase Form */}
      <form onSubmit={handleSaveConfig} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              className="mb-1 block text-xs font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              Google Client ID
            </label>
            <input
              type="text"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="xxxx.apps.googleusercontent.com"
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              Google Client Secret
            </label>
            <input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={
                config?.hasClientSecret ? 'Saved (leave blank to keep)' : 'GOCSPX-...'
              }
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label
              className="mb-1 block text-xs font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              Google Drive Folder Name
            </label>
            <input
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder="Midline Backups"
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>
          <div>
            <label
              className="mb-1 block text-xs font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              Backup Encryption Passphrase (AES-256)
            </label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder={
                config?.hasEncryptionPassphrase
                  ? 'Saved (leave blank to keep)'
                  : 'Required for encrypted cloud backups'
              }
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>
        </div>

        <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Save your encryption passphrase in a password manager — you will need it if you ever
          restore a cloud backup onto a brand-new server.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-medium transition disabled:opacity-50"
            style={{ borderColor: 'var(--border)' }}
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Save Settings
          </button>

          <button
            type="button"
            onClick={handleConnect}
            disabled={connecting || (!clientId.trim() && !config?.clientId)}
            className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold text-stone-950 transition disabled:opacity-50"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            {connecting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Link2 className="h-3.5 w-3.5" />
            )}
            {config?.connected ? 'Reconnect Google Drive' : 'Connect Google Drive'}
          </button>

          {config?.connected && (
            <button
              type="button"
              onClick={handleDisconnect}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3.5 py-2 text-xs font-medium transition hover:opacity-80"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              <Unlink className="h-3.5 w-3.5" />
              Disconnect
            </button>
          )}
        </div>
      </form>

      {/* Connected Controls: Schedule, Backup Now, Cloud Backups List */}
      {config?.connected && (
        <div
          className="space-y-4 border-t pt-4"
          style={{ borderColor: 'var(--border)' }}
        >
          {/* Backup Now + Last Status */}
          <div
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border px-4 py-3"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
            }}
          >
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Encrypted Cloud Backup</div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {config.lastBackupAt
                  ? `Last backup: ${new Date(config.lastBackupAt).toLocaleString()}${
                      config.lastBackupSize ? ` (${formatBytes(config.lastBackupSize)})` : ''
                    }`
                  : 'No cloud backups uploaded yet.'}
              </div>
              {config.lastBackupError && (
                <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
                  Last error: {config.lastBackupError}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={handleBackupNow}
              disabled={backingUp || !config.hasEncryptionPassphrase}
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-stone-950 transition disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {backingUp ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CloudUpload className="h-4 w-4" />
              )}
              {backingUp ? 'Encrypting & Uploading…' : 'Back Up Now'}
            </button>
          </div>

          {!config.hasEncryptionPassphrase && (
            <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
              Enter and save an Encryption Passphrase above to enable Google Drive backups.
            </div>
          )}

          {/* Schedule & Retention */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div
                className="mb-2 text-xs font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Auto-Backup Schedule
              </div>
              <div className="flex flex-wrap gap-1.5">
                {SCHEDULE_OPTIONS.map((opt) => {
                  const active = config.schedule === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => handleScheduleChange(opt.value, config.retentionCount)}
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

            <div>
              <div
                className="mb-2 text-xs font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Keep Last Backups
              </div>
              <div className="flex flex-wrap gap-1.5">
                {RETENTION_OPTIONS.map((count) => {
                  const active = config.retentionCount === count;
                  return (
                    <button
                      key={count}
                      type="button"
                      onClick={() => handleScheduleChange(config.schedule, count)}
                      className="rounded-lg border px-3 py-1.5 text-xs font-medium transition"
                      style={{
                        borderColor: active ? 'var(--accent)' : 'var(--border)',
                        backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
                        color: active ? 'var(--accent)' : 'var(--text-muted)',
                      }}
                    >
                      {count}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Cloud Backups List */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div
                className="text-xs font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Backups in Google Drive ({backups.length})
              </div>
              <button
                type="button"
                onClick={loadBackups}
                disabled={loadingList}
                className="inline-flex items-center gap-1 text-xs font-medium transition hover:opacity-80"
                style={{ color: 'var(--text-muted)' }}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingList ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            {backups.length === 0 ? (
              <div
                className="rounded-lg border px-3.5 py-3 text-xs"
                style={{
                  backgroundColor: 'var(--bg-subtle)',
                  borderColor: 'var(--border)',
                  color: 'var(--text-muted)',
                }}
              >
                {loadingList ? 'Loading backups from Google Drive…' : 'No backups found in this folder yet.'}
              </div>
            ) : (
              <div className="space-y-2">
                {backups.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-lg border px-3.5 py-2.5 text-sm"
                    style={{
                      backgroundColor: 'var(--bg-subtle)',
                      borderColor: 'var(--border)',
                    }}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 font-medium text-xs sm:text-sm truncate">
                        {item.encrypted && (
                          <Lock className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
                        )}
                        <span className="truncate">{item.name}</span>
                      </div>
                      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {item.createdTime
                          ? new Date(item.createdTime).toLocaleString()
                          : 'Unknown date'}{' '}
                        · {formatBytes(item.size)}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleRestoreCloud(item)}
                        disabled={restoringId !== null}
                        className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50"
                        style={{ borderColor: 'var(--border)' }}
                      >
                        {restoringId === item.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <RotateCcw className="h-3.5 w-3.5" />
                        )}
                        Restore
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteCloud(item)}
                        disabled={restoringId !== null}
                        className="rounded-lg p-1.5 transition hover:opacity-80"
                        style={{ color: 'var(--text-muted)' }}
                        title="Delete from Google Drive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {msg && <div className="text-xs font-medium text-emerald-500">{msg}</div>}
      {err && (
        <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
          {err}
        </div>
      )}
    </section>
  );
}
