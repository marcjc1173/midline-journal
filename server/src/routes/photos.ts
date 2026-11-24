import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { v4 as uuidv4 } from 'uuid';
import { db, THUMBS_DIR, UPLOADS_DIR } from '../db.js';
import { serializePhoto } from './entries.js';

const router = Router();

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '.jpg').toLowerCase() || '.jpg';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.heif'].includes(ext)
      ? ext
      : '.jpg';
    cb(null, `${uuidv4()}${safeExt}`);
  },
});

export const MAX_PHOTOS_PER_ENTRY = 10;
export const MAX_PHOTO_SIZE_MB = 15;

const upload = multer({
  storage,
  limits: { fileSize: MAX_PHOTO_SIZE_MB * 1024 * 1024, files: MAX_PHOTOS_PER_ENTRY },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are supported.'));
    }
  },
});

function cleanupUploadedFiles(files: Express.Multer.File[]) {
  for (const file of files) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      // ignore
    }
  }
}

// POST /api/photos/entry/:entryId
router.post('/entry/:entryId', upload.array('photos', MAX_PHOTOS_PER_ENTRY), async (req, res) => {
  const { entryId } = req.params;
  const files = (req.files as Express.Multer.File[]) || [];

  const entry = db.prepare('SELECT id FROM entries WHERE id = ?').get(entryId);
  if (!entry) {
    cleanupUploadedFiles(files);
    res.status(404).json({ error: 'Entry not found.' });
    return;
  }

  if (files.length === 0) {
    res.status(400).json({ error: 'No photos uploaded.' });
    return;
  }

  const existingCountRow = db
    .prepare('SELECT COUNT(*) as c FROM photos WHERE entry_id = ?')
    .get(entryId) as { c: number };

  if (existingCountRow.c + files.length > MAX_PHOTOS_PER_ENTRY) {
    cleanupUploadedFiles(files);
    const remaining = Math.max(0, MAX_PHOTOS_PER_ENTRY - existingCountRow.c);
    res.status(400).json({
      error:
        remaining === 0
          ? `This entry already has the maximum of ${MAX_PHOTOS_PER_ENTRY} photos.`
          : `You can attach up to ${MAX_PHOTOS_PER_ENTRY} photos per entry (${remaining} slot${
              remaining === 1 ? '' : 's'
            } remaining).`,
    });
    return;
  }

  const maxSortRow = db
    .prepare('SELECT COALESCE(MAX(sort_order), -1) as m FROM photos WHERE entry_id = ?')
    .get(entryId) as { m: number };
  let sortOrder = maxSortRow.m + 1;

  const created = [];

  for (const file of files) {
    const id = uuidv4();
    const thumbFilename = `${id}_thumb.jpg`;
    const thumbPath = path.join(THUMBS_DIR, thumbFilename);
    let hasThumb = false;

    try {
      await sharp(file.path)
        .rotate()
        .resize({ width: 520, height: 520, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(thumbPath);
      hasThumb = true;
    } catch (err) {
      console.warn('Could not generate thumbnail for', file.originalname, err);
    }

    db.prepare(
      `INSERT INTO photos (id, entry_id, filename, thumb_filename, original_name, mime_type, size_bytes, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      entryId,
      file.filename,
      hasThumb ? thumbFilename : null,
      file.originalname,
      file.mimetype,
      file.size,
      sortOrder++
    );

    const row = db.prepare('SELECT * FROM photos WHERE id = ?').get(id) as Parameters<
      typeof serializePhoto
    >[0];
    created.push(serializePhoto(row));
  }

  res.status(201).json({ photos: created });
});

// GET /api/photos/:id
router.get('/:id', (req, res) => {
  const row = db
    .prepare('SELECT filename, mime_type FROM photos WHERE id = ?')
    .get(req.params.id) as { filename: string; mime_type: string } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Photo not found.' });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, row.filename);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Photo file missing.' });
    return;
  }

  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(row.mime_type);
  res.sendFile(filePath);
});

// GET /api/photos/:id/thumb
router.get('/:id/thumb', (req, res) => {
  const row = db
    .prepare('SELECT filename, thumb_filename, mime_type FROM photos WHERE id = ?')
    .get(req.params.id) as
    | { filename: string; thumb_filename: string | null; mime_type: string }
    | undefined;

  if (!row) {
    res.status(404).json({ error: 'Photo not found.' });
    return;
  }

  if (row.thumb_filename) {
    const thumbPath = path.join(THUMBS_DIR, row.thumb_filename);
    if (fs.existsSync(thumbPath)) {
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.type('image/jpeg');
      res.sendFile(thumbPath);
      return;
    }
  }

  const origPath = path.join(UPLOADS_DIR, row.filename);
  if (!fs.existsSync(origPath)) {
    res.status(404).json({ error: 'Photo file missing.' });
    return;
  }

  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type(row.mime_type);
  res.sendFile(origPath);
});

// PATCH /api/photos/:id
router.patch('/:id', (req, res) => {
  const { caption = '' } = req.body as { caption?: string };
  const result = db
    .prepare('UPDATE photos SET caption = ? WHERE id = ?')
    .run(String(caption).trim().slice(0, 300), req.params.id);

  if (result.changes === 0) {
    res.status(404).json({ error: 'Photo not found.' });
    return;
  }
  res.json({ ok: true });
});

// DELETE /api/photos/:id
router.delete('/:id', (req, res) => {
  const row = db
    .prepare('SELECT filename, thumb_filename FROM photos WHERE id = ?')
    .get(req.params.id) as { filename: string; thumb_filename: string | null } | undefined;

  if (!row) {
    res.status(404).json({ error: 'Photo not found.' });
    return;
  }

  db.prepare('DELETE FROM photos WHERE id = ?').run(req.params.id);

  try {
    fs.unlinkSync(path.join(UPLOADS_DIR, row.filename));
  } catch {
    // ignore
  }
  if (row.thumb_filename) {
    try {
      fs.unlinkSync(path.join(THUMBS_DIR, row.thumb_filename));
    } catch {
      // ignore
    }
  }

  res.json({ ok: true });
});

export default router;
