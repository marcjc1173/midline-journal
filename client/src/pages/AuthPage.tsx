import React, { useRef, useState } from 'react';
import { Fingerprint, KeyRound, Loader2, Lock, ShieldCheck, Upload } from 'lucide-react';
import { ApiError, api } from '../api';
import { useAuth } from '../context/AuthContext';

export function AuthPage() {
  const { status, refresh, markUnlocked } = useAuth();
  const isSetup = status ? !status.setupComplete : false;

  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState('');
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [error, setError] = useState('');
  const restoreInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (isSetup) {
      if (password.length < 4) {
        setError('Choose a password or PIN of at least 4 characters.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setLoading(true);
    try {
      if (isSetup) {
        await api.setup(password, displayName);
      } else {
        await api.login(password);
      }
      markUnlocked();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setError('');
    setPasskeyLoading(true);
    try {
      await api.loginWithPasskey();
      markUnlocked();
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Passkey unlock was cancelled or failed.'
      );
    } finally {
      setPasskeyLoading(false);
    }
  };

  const executeFirstRunRestore = async (file: File, passphrase?: string) => {
    setError('');
    setRestoreMsg('');
    setRestoring(true);
    try {
      const result = await api.restoreBackup(file, passphrase);
      const photoPart =
        result.photosRestored !== null
          ? ` and ${result.photosRestored} photo${result.photosRestored === 1 ? '' : 's'}`
          : '';
      setPendingRestoreFile(null);
      setRestorePassphrase('');
      setRestoreMsg(
        `Restored ${result.entryCount} entr${result.entryCount === 1 ? 'y' : 'ies'}${photoPart}. Unlock with your backup's password or passkey.`
      );
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PASSPHRASE_REQUIRED') {
        setPendingRestoreFile(file);
        setError('This backup is encrypted. Enter its backup passphrase below to decrypt and restore.');
      } else {
        setError(err instanceof Error ? err.message : 'Could not restore backup file.');
      }
    } finally {
      setRestoring(false);
      if (restoreInputRef.current) {
        restoreInputRef.current.value = '';
      }
    }
  };

  const handleFirstRunRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.name.toLowerCase().endsWith('.enc')) {
      setError('');
      setPendingRestoreFile(file);
      return;
    }
    await executeFirstRunRestore(file);
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12">
      <div
        className="w-full max-w-md rounded-2xl border p-7 sm:p-8 shadow-lg"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border)',
        }}
      >
        <div className="flex flex-col items-center text-center mb-7">
          <img src="/icon.svg" alt="Midline" className="h-12 w-12 rounded-xl mb-3" />
          <h1 className="text-2xl font-bold tracking-tight">Midline</h1>
          <p className="mt-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
            {isSetup
              ? 'Set up your private journal. Everything stays on your own server.'
              : 'Your private space. Unlock to continue.'}
          </p>
        </div>

          {restoreMsg && (
            <div className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3.5 py-2.5 text-xs font-medium text-emerald-500">
              {restoreMsg}
            </div>
          )}

          {/* Passkey unlock button if registered */}
        {!isSetup && status?.hasPasskeys && (
          <div className="mb-6">
            <button
              type="button"
              onClick={handlePasskeyLogin}
              disabled={passkeyLoading}
              className="flex w-full items-center justify-center gap-2.5 rounded-xl px-4 py-3 text-sm font-semibold text-stone-950 transition hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {passkeyLoading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <Fingerprint className="h-5 w-5" />
              )}
              Unlock with Passkey
            </button>

            <div className="relative my-5 flex items-center">
              <div className="flex-1 border-t" style={{ borderColor: 'var(--border)' }} />
              <span
                className="px-3 text-xs uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                or password / PIN
              </span>
              <div className="flex-1 border-t" style={{ borderColor: 'var(--border)' }} />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSetup && (
            <div>
              <label
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                First Name (optional)
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Mike"
                className="w-full rounded-lg border px-3.5 py-2.5 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-subtle)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>
          )}

          <div>
            <label
              className="mb-1.5 block text-xs font-medium uppercase tracking-wider"
              style={{ color: 'var(--text-muted)' }}
            >
              {isSetup ? 'Choose a Password or PIN' : 'Password or PIN'}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSetup ? 'At least 4 characters' : 'Enter password or PIN'}
              autoFocus={!status?.hasPasskeys}
              required
              className="w-full rounded-lg border px-3.5 py-2.5 text-sm focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>

          {isSetup && (
            <div>
              <label
                className="mb-1.5 block text-xs font-medium uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Confirm Password or PIN
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password or PIN"
                required
                className="w-full rounded-lg border px-3.5 py-2.5 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-subtle)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>
          )}

          {error && (
            <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50"
            style={{
              backgroundColor:
                !isSetup && status?.hasPasskeys ? 'var(--bg-subtle)' : 'var(--accent)',
              color:
                !isSetup && status?.hasPasskeys ? 'var(--text)' : '#141517',
            }}
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isSetup ? (
              <ShieldCheck className="h-4 w-4" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {isSetup ? 'Create Private Journal' : 'Unlock'}
          </button>
        </form>

        {isSetup && (
          <div className="mt-5 space-y-4">
            <div className="relative flex items-center">
              <div className="flex-1 border-t" style={{ borderColor: 'var(--border)' }} />
              <span
                className="px-3 text-xs uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                or restore existing journal
              </span>
              <div className="flex-1 border-t" style={{ borderColor: 'var(--border)' }} />
            </div>

            <input
              ref={restoreInputRef}
              type="file"
              accept=".tar.gz,.tar.gz.enc,.enc,.tgz,.gz,.db,application/gzip,application/x-gzip"
              onChange={handleFirstRunRestore}
              className="hidden"
            />
            {pendingRestoreFile ? (
              <div
                className="rounded-xl border p-3.5 space-y-2.5"
                style={{
                  borderColor: 'var(--border)',
                  backgroundColor: 'var(--bg-subtle)',
                }}
              >
                <div className="flex items-center gap-2 text-xs font-medium">
                  <Lock className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
                  <span className="truncate">{pendingRestoreFile.name}</span>
                </div>
                <input
                  type="password"
                  value={restorePassphrase}
                  onChange={(e) => setRestorePassphrase(e.target.value)}
                  placeholder="Enter backup encryption passphrase"
                  className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                  style={{
                    backgroundColor: 'var(--bg-elevated)',
                    borderColor: 'var(--border)',
                    color: 'var(--text)',
                  }}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={restoring || !restorePassphrase}
                    onClick={() => executeFirstRunRestore(pendingRestoreFile, restorePassphrase)}
                    className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-stone-950 transition disabled:opacity-50"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Decrypt &amp; Restore
                  </button>
                  <button
                    type="button"
                    disabled={restoring}
                    onClick={() => {
                      setPendingRestoreFile(null);
                      setRestorePassphrase('');
                    }}
                    className="rounded-lg border px-3 py-2 text-xs font-medium"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                disabled={restoring}
                onClick={() => restoreInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition hover:opacity-90 disabled:opacity-50"
                style={{
                  borderColor: 'var(--border)',
                  backgroundColor: 'var(--bg-subtle)',
                }}
              >
                {restoring ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4" />
                )}
                {restoring ? 'Restoring Backup…' : 'Restore from Backup File'}
              </button>
            )}

            <p
              className="text-center text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              You can add a phone Passkey (Face ID / Touch ID / Fingerprint) in Settings right
              after signing in.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
