import { Router } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db.js';
import {
  buildJournalPdf,
  buildPlainTextExport,
  queryExportEntries,
  type ExportOptions,
} from '../lib/exporter.js';
import {
  buildDuplicateKey,
  extractTextFromUploadedFile,
  loadExistingDuplicateKeys,
  parseJournalImportText,
  type ParsedImportEntry,
} from '../lib/importer.js';

const router = Router();

export const MAX_IMPORT_UPLOAD_MB = 25;

const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMPORT_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const lower = (file.originalname || '').toLowerCase();
    const okExt =
      lower.endsWith('.txt') ||
      lower.endsWith('.md') ||
      lower.endsWith('.markdown') ||
      lower.endsWith('.pdf');
    const okMime =
      file.mimetype === 'text/plain' ||
      file.mimetype === 'text/markdown' ||
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/octet-stream';

    if (okExt || okMime) {
      cb(null, true);
    } else {
      cb(new Error('Please upload a .txt, .md, or .pdf journal export file.'));
    }
  },
});

function getExportDateSlug(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
}

function parseExportOptions(query: Record<string, unknown>): ExportOptions {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const bool = (v: unknown, def: boolean) => {
    if (v === 'false' || v === '0') return false;
    if (v === 'true' || v === '1') return true;
    return def;
  };

  return {
    from: str(query.from) || undefined,
    to: str(query.to) || undefined,
    order: str(query.order) === 'desc' ? 'desc' : 'asc',
    title: str(query.title) || undefined,
    subtitle: str(query.subtitle) || undefined,
    paperStyle: str(query.paperStyle) === 'white' ? 'white' : 'warm',
    includePhotos: bool(query.includePhotos, true),
    includeMetadata: bool(query.includeMetadata, true),
    includeToc: bool(query.includeToc, true),
  };
}

// GET /api/transfer/export/text
router.get('/export/text', (req, res) => {
  try {
    const opts = parseExportOptions(req.query as Record<string, unknown>);
    const entries = queryExportEntries(opts);
    const text = buildPlainTextExport(entries, opts);
    const filename = `midline-journal-${getExportDateSlug()}.txt`;

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Filename', filename);
    res.send(text);
  } catch (err) {
    console.error('Plain text export failed:', err);
    res.status(500).json({ error: 'Could not generate plain text export.' });
  }
});

// GET /api/transfer/export/pdf
router.get('/export/pdf', async (req, res) => {
  try {
    const opts = parseExportOptions(req.query as Record<string, unknown>);
    const entries = queryExportEntries(opts);
    const pdfBuffer = await buildJournalPdf(entries, opts);
    const filename = `midline-journal-${getExportDateSlug()}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Export-Filename', filename);
    res.setHeader('Content-Length', String(pdfBuffer.length));
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF export failed:', err);
    res.status(500).json({ error: 'Could not generate PDF journal.' });
  }
});

// POST /api/transfer/import/preview
router.post('/import/preview', importUpload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Please select a .txt, .md, or .pdf file to import.' });
    return;
  }

  try {
    const { text, sourceType } = await extractTextFromUploadedFile(
      file.buffer,
      file.originalname,
      file.mimetype
    );
    const preview = parseJournalImportText(text, sourceType);
    res.json(preview);
  } catch (err) {
    console.error('Import preview failed:', err);
    res.status(400).json({
      error:
        err instanceof Error
          ? err.message
          : 'Could not read this file. Please ensure it is a valid text or PDF export.',
    });
  }
});

// POST /api/transfer/import/commit
router.post('/import/commit', (req, res) => {
  const {
    entries,
    skipDuplicates = true,
    importTag = '',
  } = req.body as {
    entries?: ParsedImportEntry[];
    skipDuplicates?: boolean;
    importTag?: string;
  };

  if (!Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: 'No entries provided to import.' });
    return;
  }

  const cleanedImportTag = String(importTag || '')
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .slice(0, 40);

  const existingKeys = skipDuplicates ? loadExistingDuplicateKeys() : new Set<string>();

  const insertEntry = db.prepare(
    `INSERT INTO entries (id, title, content, entry_date, entry_time, entry_timestamp, mood, energy, prompt_id, prompt_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  );
  const insertTag = db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)');
  const getTag = db.prepare('SELECT id FROM tags WHERE name = ?');
  const linkTag = db.prepare(
    'INSERT OR IGNORE INTO entry_tags (entry_id, tag_id) VALUES (?, ?)'
  );

  let imported = 0;
  let skipped = 0;

  const runImport = db.transaction((items: ParsedImportEntry[]) => {
    for (const item of items) {
      const dateVal =
        typeof item.entry_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.entry_date)
          ? item.entry_date
          : getExportDateSlug();
      const timeVal =
        typeof item.entry_time === 'string' && /^\d{2}:\d{2}$/.test(item.entry_time)
          ? item.entry_time
          : '12:00';
      const titleVal = String(item.title || '').trim().slice(0, 200);
      const contentVal = String(item.content || '').trim();
      const promptVal = item.prompt_text ? String(item.prompt_text).trim() : null;

      if (!contentVal && !titleVal && !promptVal) {
        skipped++;
        continue;
      }

      const key = buildDuplicateKey({
        entry_date: dateVal,
        title: titleVal,
        content: contentVal,
      });

      if (skipDuplicates && existingKeys.has(key)) {
        skipped++;
        continue;
      }

      const id = uuidv4();
      const timestamp = `${dateVal}T${timeVal}:00`;
      const energyVal =
        item.energy !== null &&
        item.energy !== undefined &&
        Number(item.energy) >= 1 &&
        Number(item.energy) <= 5
          ? Number(item.energy)
          : null;

      insertEntry.run(
        id,
        titleVal,
        contentVal,
        dateVal,
        timeVal,
        timestamp,
        item.mood || null,
        energyVal,
        promptVal
      );

      const combinedTags = [
        ...new Set(
          [
            ...(Array.isArray(item.tags) ? item.tags : []),
            ...(cleanedImportTag ? [cleanedImportTag] : []),
          ]
            .map((t) => String(t).trim().toLowerCase().replace(/^#/, ''))
            .filter((t) => t.length > 0 && t.length <= 40)
        ),
      ];

      for (const tagName of combinedTags) {
        insertTag.run(tagName);
        const row = getTag.get(tagName) as { id: number } | undefined;
        if (row) {
          linkTag.run(id, row.id);
        }
      }

      existingKeys.add(key);
      imported++;
    }
  });

  try {
    runImport(entries);
    res.json({ ok: true, imported, skipped });
  } catch (err) {
    console.error('Import commit failed:', err);
    res.status(500).json({ error: 'Could not save imported entries.' });
  }
});

export default router;
