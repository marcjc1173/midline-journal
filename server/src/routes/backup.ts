import { Router, type Request, type Response, type NextFunction } from 'express';
import Database from 'better-sqlite3';
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

// Allow restore either when authenticated, OR during initial setup before a password exists
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

function formatBackupFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}`;
  return `midline-backup-${stamp}.tar.gz`;
}

function formatSafetyStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(
    date.getHours()
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

async function detectFileFormat(filePath: string): Promise<'gzip' | 'sqlite' | 'unknown'> {
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

// GET /api/backup/info
router.get('/info', requireAuth, (_req, res) => {
  const entryCount = (
    db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number }
  ).c;
  const photoCount = (
    db.prepare('SELECT COUNT(*) as c FROM photos').get() as { c: number }
  ).c;

  const dbSizeBytes =
    getFileSizeSafe(DB_PATH) + getFileSizeSafe(`${DB_PATH}-wal`);
  const { bytes: uploadsSizeBytes } = getDirSizeAndFiles(UPLOADS_DIR);

  res.json({
    entryCount,
    photoCount,
    dbSizeBytes,
    uploadsSizeBytes,
    totalEstimatedBytes: dbSizeBytes + uploadsSizeBytes,
  });
});

// GET /api/backup/download
router.get('/download', requireAuth, async (_req, res) => {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-backup-'));
  const snapshotPath = path.join(tmpDir, 'midline.db');

  try {
    // Take a consistent live snapshot of SQLite without locking out the app
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

    const downloadName = formatBackupFilename(now);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Cache-Control', 'no-store');

    await packTarGz(items, res);
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
    const stageDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'midline-restore-'));

    try {
      const format = await detectFileFormat(uploadedFile.path);
      const stagedDbPath = path.join(stageDir, 'midline.db');
      const stagedUploadsDir = path.join(stageDir, 'uploads');
      let hasUploadsArchive = false;

      if (format === 'gzip') {
        const result = await extractTarGz(uploadedFile.path, stageDir, {
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
        await fs.promises.copyFile(uploadedFile.path, stagedDbPath);
      } else {
        res.status(400).json({
          error:
            'Unsupported file format. Please upload a Midline .tar.gz backup archive (or midline.db file).',
        });
        return;
      }

      // Validate SQLite integrity & schema BEFORE touching live data
      let summary: { entryCount: number; photoCount: number; hasPassword: boolean };
      try {
        summary = validateStagedDatabase(stagedDbPath);
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? err.message : 'Invalid backup database.',
        });
        return;
      }

      // Begin atomic swap
      setDbRestoring(true);
      try {
        // Save a safety copy of existing data inside DATA_DIR (works cleanly with Docker volumes)
        const existingEntries = isSetupComplete();
        if (fs.existsSync(DB_PATH) && existingEntries) {
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

        // Close live DB, clear WAL/SHM sidecars, swap in restored DB
        closeDb();
        for (const ext of ['-wal', '-shm']) {
          const sidecar = `${DB_PATH}${ext}`;
          if (fs.existsSync(sidecar)) {
            fs.unlinkSync(sidecar);
          }
        }
        await fs.promises.copyFile(stagedDbPath, DB_PATH);

        // Replace photos if restoring a full .tar.gz backup
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

        // Reopen database & ensure schema/indexes are up to date
        reopenDb();
        initDb();

        // Auth handoff:
        // - If already authenticated in Settings, re-issue session cookie so the user stays unlocked.
        // - If restoring from the unauthenticated first-run setup screen, require unlocking with the restored password/passkey.
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
        // Best-effort recovery: make sure DB handle is reopened if swap failed midway
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
    } catch (err) {
      console.error('Backup restore error:', err);
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Restore failed. Your existing data was preserved.',
      });
    } finally {
      await fs.promises.unlink(uploadedFile.path).catch(() => {});
      await fs.promises.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    }
  }
);

export default router;
