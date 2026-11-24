import { Router, type Request, type Response, type NextFunction } from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import multer from 'multer';
import {
  DATA_DIR,
  DB_PATH,
  THUMBS_DIR,
  UPLOADS_DIR,
  closeDb,
  db,
  initDb,
  isDbRestoring,
  reopenDb,
  setDbRestoring,
} from '../db.js';
import {
  clearSessionCookie,
  isAuthenticated,
  isSetupComplete,
  requireAuth,
  setSessionCookie,
} from '../auth.js';
import { extractTarGz, packTarGz, type TarPackItem } from '../lib/tar.js';
import {
  decryptBackupFile,
  encryptBackupFile,
  isEncryptedBackupFile,
} from '../lib/crypto.js';
import {
  buildGDriveAuthUrl,
  deleteDriveBackup,
  disconnectGDrive,
  downloadDriveBackup,
  exchangeGDriveCode,
  getGDriveConfigPublic,
  getSavedGDrivePassphrase,
  listDriveBackups,
  pruneOldDriveBackups,
  recordGDriveBackupError,
  recordGDriveBackupSuccess,
  saveGDriveSettings,
  uploadBackupToDrive,
  type BackupSchedule,
} from '../lib/gdrive.js';

const router = Router();

export const MAX_BACKUP_UPLOAD_MB = 2048; // 2 GB

const REQUIRED_TABLES = [
  'settings',
  'passkeys',
  'prompts',
  'entries',
  'tags',
  'entry_tags',
  'photos',
];

const backupUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = path.join(os.tmpdir(), 'midline-restore-uploads');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => {
      cb(null, `restore-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    },
  }),
  limits: {
    fileSize: MAX_BACKUP_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
});

// Pending Google OAuth state (single-user, 10-minute TTL)
let pendingOAuthState: { state: string; redirectUri: string; expiresAt: number } | null = null;
let cloudBackupInProgress = false;

function requireAuthOrInitialSetup(req: Request, res: Response, next: NextFunction): void {
  if (!isSetupComplete()) {
    next();
    return;
  }
  requireAuth(req, res, next);
}

function getFileSizeSafe(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function getDirSizeAndFiles(dirPath: string): { bytes: number; files: string[] } {
  let bytes = 0;
  const files: string[] = [];
  if (!fs.existsSync(dirPath)) return { bytes, files };

  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(dirPath, entry.name);
    bytes += getFileSizeSafe(full);
    files.push(entry.name);
  }
  return { bytes, files };
}

function formatBackupFilename(date: Date, encrypted: boolean): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`;
  return encrypted ? `midline-backup-${stamp}.tar.gz.enc` : `midline-backup-${stamp}.tar.gz`;
}

function formatSafetyStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function getRedirectUri(req: Request): string {
  if (process.env.ORIGIN) {
    return `${process.env.ORIGIN.replace(/\/$/, '')}/api/backup/gdrive/callback`;
  }
  const proto =
    (typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : null) || (req.secure ? 'https' : 'http');
  const host =
    (typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : null) ||
    req.headers.host ||
    'localhost:3001';
  return `${proto}://${host}/api/backup/gdrive/callback`;
}

async function detectFileFormat(
  filePath: string
): Promise<'encrypted' | 'gzip' | 'sqlite' | 'unknown'> {
  if (await isEncryptedBackupFile(filePath)) {
    return 'encrypted';
  }
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buf, 0, 16, 0);
    if (bytesRead >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
      return 'gzip';
    }
    if (bytesRead >= 16 && buf.toString('ascii', 0, 16) === 'SQLite format 3\0') {
      return 'sqlite';
    }
    return 'unknown';
  } finally {
    await handle.close();
  }
}

function validateStagedDatabase(stagedDbPath: string): {
  entryCount: number;
  photoCount: number;
  hasPassword: boolean;
} {
  let testDb: Database.Database | null = null;
  try {
    testDb = new Database(stagedDbPath, { readonly: true, fileMustExist: true });

    const checkRow = testDb.pragma('integrity_check') as { integrity_check: string }[];
    const checkResult = checkRow[0]?.integrity_check;
    if (checkResult !== 'ok') {
      throw new Error(`Backup database failed integrity check (${checkResult || 'unknown'}).`);
    }

    const tables = (
      testDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
    if (missing.length > 0) {
      throw new Error(
        `This file does not appear to be a valid Midline backup (missing tables: ${missing.join(', ')}).`
      );
    }

    const entryCount = (
      testDb.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }
    ).c;
    const photoCount = (
      testDb.prepare('SELECT COUNT(*) as c FROM photos').get() as { c: number }
    ).c;
    const pwRow = testDb
      .prepare("SELECT value FROM settings WHERE key = 'password_hash'")
      .get() as { value: string } | undefined;

    return {
      entryCount,
      photoCount,
      hasPassword: Boolean(pwRow?.value),
    };
  } finally {
    if (testDb && testDb.open) {
      testDb.close();
    }
  }
}

function clearDirectoryFiles(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.unlinkSync(path.join(dirPath, entry.name));
    }
  }
}

// Creates a backup archive file (.tar.gz or encrypted .tar.gz.enc) in tmpDir
async function buildBackupFileOnDisk(
  tmpDir: string,
  passphrase?: string
): Promise<{ filePath: string; filename: string; sizeBytes: number; encrypted: boolean }> {
  const snapshotPath = path.join(tmpDir, 'midline.db');
  await db.backup(snapshotPath);

  const entryCount = (
    db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }
  ).c;
  const photoCount = (
    db.prepare('SELECT COUNT(*) as c FROM photos').get() as { c: number }
  ).c;

  const now = new Date();
  const manifest = {
    app: 'midline-journal',
    formatVersion: 1,
    createdAt: now.toISOString(),
    entryCount,
    photoCount,
  };

  const items: TarPackItem[] = [
    {
      name: 'manifest.json',
      content: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
    },
    {
      name: 'midline.db',
      filePath: snapshotPath,
    },
  ];

  const { files: uploadFiles } = getDirSizeAndFiles(UPLOADS_DIR);
  for (const filename of uploadFiles) {
    items.push({
      name: `uploads/${filename}`,
      filePath: path.join(UPLOADS_DIR, filename),
    });
  }

  const tarPath = path.join(tmpDir, 'backup.tar.gz');
  const ws = fs.createWriteStream(tarPath);
  await packTarGz(items, ws);

  const encrypted = Boolean(passphrase && passphrase.length > 0);
  const filename = formatBackupFilename(now, encrypted);

  if (encrypted && passphrase) {
    const encPath = path.join(tmpDir, 'backup.tar.gz.enc');
    await encryptBackupFile(tarPath, encPath, passphrase);
    await fs.promises.unlink(tarPath).catch(() => {});
    const stat = await fs.promises.stat(encPath);
    return { filePath: encPath, filename, sizeBytes: stat.size, encrypted: true };
  }

  const stat = await fs.promises.stat(tarPath);
  return { filePath: tarPath, filename, sizeBytes: stat.size, encrypted: false };
}

async function performRestoreFromFile(
  sourceFilePath: string,
  opts: {
    passphrase?: string;
    wasAuthenticated: boolean;
    req: Request;
    res: Response;
  }
): Promise<void> {
  const { passphrase, wasAuthenticated, req, res } = opts;
  const stageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-restore-'));

  try {
    let workingPath = sourceFilePath;
    let format = await detectFileFormat(workingPath);

    if (format === 'encrypted') {
      if (!passphrase) {
        res.status(400).json({
          code: 'PASSPHRASE_REQUIRED',
          error: 'This backup is encrypted. Please enter its backup passphrase.',
        });
        return;
      }
      const decryptedPath = path.join(stageDir, 'decrypted.bin');
      try {
        await decryptBackupFile(workingPath, decryptedPath, passphrase);
      } catch (err) {
        res.status(400).json({
          code: 'INVALID_PASSPHRASE',
          error:
            err instanceof Error
              ? err.message
              : 'Incorrect backup passphrase or corrupted encrypted backup.',
        });
        return;
      }
      workingPath = decryptedPath;
      format = await detectFileFormat(workingPath);
    }

    const stagedDbPath = path.join(stageDir, 'midline.db');
    const stagedUploadsDir = path.join(stageDir, 'uploads');
    let hasUploadsArchive = false;

    if (format === 'gzip') {
      const result = await extractTarGz(workingPath, stageDir, {
        isAllowedEntry: (name) => {
          if (name === 'midline.db' || name === 'manifest.json') return true;
          if (name.startsWith('uploads/')) {
            const rest = name.slice('uploads/'.length);
            return rest.length > 0 && !rest.includes('/');
          }
          return false;
        },
      });
      hasUploadsArchive = true;
      if (!result.extractedFiles.includes('midline.db')) {
        res.status(400).json({
          error: 'Backup archive does not contain a midline.db database file.',
        });
        return;
      }
    } else if (format === 'sqlite') {
      await fs.promises.copyFile(workingPath, stagedDbPath);
    } else {
      res.status(400).json({
        error:
          'Unsupported file format. Please upload a Midline .tar.gz, .tar.gz.enc, or midline.db backup.',
      });
      return;
    }

    let summary: { entryCount: number; photoCount: number; hasPassword: boolean };
    try {
      summary = validateStagedDatabase(stagedDbPath);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid backup database.',
      });
      return;
    }

    setDbRestoring(true);
    try {
      const existingSetup = isSetupComplete();
      if (fs.existsSync(DB_PATH) && existingSetup) {
        const safetyDir = path.join(DATA_DIR, `.pre-restore-${formatSafetyStamp(new Date())}`);
        await fs.promises.mkdir(safetyDir, { recursive: true });
        await db.backup(path.join(safetyDir, 'midline.db'));
        if (fs.existsSync(UPLOADS_DIR)) {
          const safetyUploads = path.join(safetyDir, 'uploads');
          await fs.promises.mkdir(safetyUploads, { recursive: true });
          const { files } = getDirSizeAndFiles(UPLOADS_DIR);
          for (const f of files) {
            await fs.promises.copyFile(path.join(UPLOADS_DIR, f), path.join(safetyUploads, f));
          }
        }
      }

      closeDb();
      for (const ext of ['-wal', '-shm']) {
        const sidecar = `${DB_PATH}${ext}`;
        if (fs.existsSync(sidecar)) {
          fs.unlinkSync(sidecar);
        }
      }
      await fs.promises.copyFile(stagedDbPath, DB_PATH);

      let restoredPhotosCount = 0;
      if (hasUploadsArchive) {
        clearDirectoryFiles(UPLOADS_DIR);
        clearDirectoryFiles(THUMBS_DIR);
        if (fs.existsSync(stagedUploadsDir)) {
          const { files } = getDirSizeAndFiles(stagedUploadsDir);
          for (const f of files) {
            await fs.promises.copyFile(
              path.join(stagedUploadsDir, f),
              path.join(UPLOADS_DIR, f)
            );
            restoredPhotosCount++;
          }
        }
      }

      reopenDb();
      initDb();

      let requiresUnlock = false;
      if (wasAuthenticated && summary.hasPassword) {
        setSessionCookie(req, res);
      } else {
        clearSessionCookie(res);
        requiresUnlock = summary.hasPassword;
      }

      res.json({
        ok: true,
        entryCount: summary.entryCount,
        photoCount: summary.photoCount,
        photosRestored: hasUploadsArchive ? restoredPhotosCount : null,
        requiresUnlock,
      });
    } catch (swapErr) {
      try {
        reopenDb();
        initDb();
      } catch (reopenErr) {
        console.error('Failed to reopen DB after restore error:', reopenErr);
      }
      throw swapErr;
    } finally {
      setDbRestoring(false);
    }
  } finally {
    await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runGDriveBackup(): Promise<{
  id: string;
  name: string;
  size: number;
  pruned: number;
}> {
  if (cloudBackupInProgress) {
    throw new Error('A Google Drive backup is already in progress.');
  }
  const cfg = getGDriveConfigPublic();
  if (!cfg.connected) {
    throw new Error('Google Drive is not connected.');
  }
  const passphrase = getSavedGDrivePassphrase();
  if (!passphrase || passphrase.length < 4) {
    throw new Error('Please set a backup encryption passphrase before backing up to Google Drive.');
  }

  cloudBackupInProgress = true;
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-gdrive-backup-'));
  try {
    const built = await buildBackupFileOnDisk(tmpDir, passphrase);
    const uploaded = await uploadBackupToDrive(built.filePath, built.filename);
    recordGDriveBackupSuccess(uploaded.name, uploaded.size);
    const pruned = await pruneOldDriveBackups(cfg.retentionCount);
    return { ...uploaded, pruned };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Google Drive backup failed.';
    recordGDriveBackupError(msg);
    throw err;
  } finally {
    cloudBackupInProgress = false;
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// Lightweight background scheduler for automatic Google Drive backups
export function startBackupScheduler(): void {
  const CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
  setInterval(() => {
    if (cloudBackupInProgress || isDbRestoring()) return;
    try {
      const cfg = getGDriveConfigPublic();
      if (!cfg.connected || !cfg.hasEncryptionPassphrase || cfg.schedule === 'off') return;

      const intervalMs =
        cfg.schedule === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
      const lastMs = cfg.lastBackupAt ? Date.parse(cfg.lastBackupAt) : 0;
      const now = Date.now();

      if (!lastMs || now - lastMs >= intervalMs) {
        console.log(`Starting scheduled (${cfg.schedule}) encrypted Google Drive backup...`);
        runGDriveBackup()
          .then((res) => {
            console.log(`Scheduled Google Drive backup complete: ${res.name} (${res.size} bytes)`);
          })
          .catch((err) => {
            console.error('Scheduled Google Drive backup failed:', err);
          });
      }
    } catch (err) {
      console.error('Backup scheduler check error:', err);
    }
  }, CHECK_INTERVAL_MS).unref();
}

// ---------------- Local Manual Backup & Restore ----------------

// GET /api/backup/info
router.get('/info', requireAuth, (_req, res) => {
  const entryCount = (
    db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }
  ).c;
  const photoCount = (
    db.prepare('SELECT COUNT(*) as c FROM photos').get() as { c: number }
  ).c;

  const dbSizeBytes = getFileSizeSafe(DB_PATH) + getFileSizeSafe(`${DB_PATH}-wal`);
  const { bytes: uploadsSizeBytes } = getDirSizeAndFiles(UPLOADS_DIR);

  res.json({
    entryCount,
    photoCount,
    dbSizeBytes,
    uploadsSizeBytes,
    totalEstimatedBytes: dbSizeBytes + uploadsSizeBytes,
  });
});

// GET /api/backup/download (unencrypted direct browser download)
router.get('/download', requireAuth, async (_req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-backup-'));
  try {
    const built = await buildBackupFileOnDisk(tmpDir);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    res.setHeader('Content-Length', String(built.sizeBytes));
    res.setHeader('Cache-Control', 'no-store');

    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(built.filePath);
      rs.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      rs.pipe(res);
    });
  } catch (err) {
    console.error('Backup download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not create backup archive.' });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// POST /api/backup/download (supports optional AES-256-GCM passphrase in request body)
router.post('/download', requireAuth, async (req, res) => {
  const { passphrase } = (req.body || {}) as { passphrase?: string };
  if (passphrase && passphrase.length > 0 && passphrase.length < 4) {
    res.status(400).json({ error: 'Encryption passphrase must be at least 4 characters.' });
    return;
  }

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-backup-'));
  try {
    const built = await buildBackupFileOnDisk(tmpDir, passphrase || undefined);
    res.setHeader(
      'Content-Type',
      built.encrypted ? 'application/octet-stream' : 'application/gzip'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${built.filename}"`);
    res.setHeader('X-Backup-Filename', built.filename);
    res.setHeader('Content-Length', String(built.sizeBytes));
    res.setHeader('Cache-Control', 'no-store');

    await new Promise<void>((resolve, reject) => {
      const rs = fs.createReadStream(built.filePath);
      rs.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      res.on('close', resolve);
      rs.pipe(res);
    });
  } catch (err) {
    console.error('Encrypted backup download error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Could not create backup archive.' });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// POST /api/backup/restore
router.post(
  '/restore',
  requireAuthOrInitialSetup,
  backupUpload.single('backup'),
  async (req, res) => {
    const uploadedFile = req.file;
    if (!uploadedFile) {
      res.status(400).json({ error: 'Please choose a backup file to restore.' });
      return;
    }

    const wasAuthenticated = isSetupComplete() && isAuthenticated(req);
    const body = (req.body || {}) as { passphrase?: string };
    const passphrase = typeof body.passphrase === 'string' ? body.passphrase : undefined;

    try {
      await performRestoreFromFile(uploadedFile.path, {
        passphrase,
        wasAuthenticated,
        req,
        res,
      });
    } catch (err) {
      console.error('Backup restore error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Restore failed. Your existing data was preserved.',
        });
      }
    } finally {
      await fs.promises.unlink(uploadedFile.path).catch(() => {});
    }
  }
);

// ---------------- Google Drive Cloud Sync ----------------

// GET /api/backup/gdrive/config
router.get('/gdrive/config', requireAuth, (req, res) => {
  res.json({
    ...getGDriveConfigPublic(),
    redirectUri: getRedirectUri(req),
  });
});

// PUT /api/backup/gdrive/config
router.put('/gdrive/config', requireAuth, (req, res) => {
  const { clientId, clientSecret, folderName, encryptionPassphrase, schedule, retentionCount } =
    (req.body || {}) as {
      clientId?: string;
      clientSecret?: string;
      folderName?: string;
      encryptionPassphrase?: string;
      schedule?: BackupSchedule;
      retentionCount?: number;
    };

  try {
    saveGDriveSettings({
      clientId,
      clientSecret,
      folderName,
      encryptionPassphrase,
      schedule,
      retentionCount,
    });
    res.json({
      ok: true,
      ...getGDriveConfigPublic(),
      redirectUri: getRedirectUri(req),
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not save Google Drive settings.',
    });
  }
});

// POST /api/backup/gdrive/connect
router.post('/gdrive/connect', requireAuth, (req, res) => {
  try {
    const redirectUri = getRedirectUri(req);
    const state = crypto.randomBytes(24).toString('hex');
    const authUrl = buildGDriveAuthUrl(redirectUri, state);
    pendingOAuthState = {
      state,
      redirectUri,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    res.json({ authUrl });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not start Google Drive sign-in.',
    });
  }
});

// GET /api/backup/gdrive/callback
router.get('/gdrive/callback', async (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const oauthError = typeof req.query.error === 'string' ? req.query.error : '';

  if (oauthError) {
    pendingOAuthState = null;
    res.redirect(`/settings?gdrive_error=${encodeURIComponent(oauthError)}`);
    return;
  }

  if (
    !pendingOAuthState ||
    pendingOAuthState.expiresAt < Date.now() ||
    pendingOAuthState.state !== state ||
    !code
  ) {
    pendingOAuthState = null;
    res.redirect(
      `/settings?gdrive_error=${encodeURIComponent('Google sign-in expired or was invalid. Please try again.')}`
    );
    return;
  }

  const { redirectUri } = pendingOAuthState;
  pendingOAuthState = null;

  try {
    await exchangeGDriveCode(code, redirectUri);
    res.redirect('/settings?gdrive=connected');
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Could not connect Google Drive.';
    res.redirect(`/settings?gdrive_error=${encodeURIComponent(msg)}`);
  }
});

// POST /api/backup/gdrive/disconnect
router.post('/gdrive/disconnect', requireAuth, (_req, res) => {
  disconnectGDrive();
  res.json({ ok: true });
});

// GET /api/backup/gdrive/backups
router.get('/gdrive/backups', requireAuth, async (_req, res) => {
  try {
    const backups = await listDriveBackups();
    res.json({ backups });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not list Google Drive backups.',
    });
  }
});

// POST /api/backup/gdrive/backup-now
router.post('/gdrive/backup-now', requireAuth, async (_req, res) => {
  try {
    const result = await runGDriveBackup();
    res.json({ ok: true, backup: result });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Google Drive backup failed.',
    });
  }
});

// POST /api/backup/gdrive/restore/:fileId
router.post('/gdrive/restore/:fileId', requireAuth, async (req, res) => {
  const fileId = String(req.params.fileId);
  const body = (req.body || {}) as { passphrase?: string };
  const passphrase =
    typeof body.passphrase === 'string' && body.passphrase.length > 0
      ? body.passphrase
      : getSavedGDrivePassphrase();

  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-gdrive-restore-'));
  const downloadedPath = path.join(tmpDir, 'cloud-backup.bin');

  try {
    await downloadDriveBackup(fileId, downloadedPath);
    await performRestoreFromFile(downloadedPath, {
      passphrase,
      wasAuthenticated: true,
      req,
      res,
    });
  } catch (err) {
    console.error('Google Drive restore error:', err);
    if (!res.headersSent) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not restore from Google Drive.',
      });
    }
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// DELETE /api/backup/gdrive/backups/:fileId
router.delete('/gdrive/backups/:fileId', requireAuth, async (req, res) => {
  try {
    await deleteDriveBackup(String(req.params.fileId));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Could not delete Google Drive backup.',
    });
  }
});

export default router;
