import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';
import { db, getSetting, UPLOADS_DIR } from '../db.js';

export interface ExportPhoto {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  caption: string;
}

export interface ExportEntry {
  id: string;
  title: string;
  content: string;
  entry_date: string; // YYYY-MM-DD
  entry_time: string; // HH:MM
  mood: string | null;
  energy: number | null;
  prompt_text: string | null;
  tags: string[];
  photos: ExportPhoto[];
}

export interface ExportOptions {
  from?: string;
  to?: string;
  order?: 'asc' | 'desc';
  title?: string;
  subtitle?: string;
  paperStyle?: 'warm' | 'white';
  includePhotos?: boolean;
  includeMetadata?: boolean;
  includeToc?: boolean;
}

const MOOD_META: Record<string, { label: string; color: string }> = {
  good: { label: 'Good', color: '#4f9d69' },
  steady: { label: 'Steady', color: '#6b9ac4' },
  grateful: { label: 'Grateful', color: '#d9923b' },
  stressed: { label: 'Stressed', color: '#d97b48' },
  heavy: { label: 'Heavy', color: '#8f7ba6' },
  low: { label: 'Low', color: '#b55d5d' },
};

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

function formatLongDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAYS_LONG[dt.getDay()]}, ${MONTHS_LONG[dt.getMonth()]} ${d}, ${y}`;
}

function formatMonthDayYear(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTHS_LONG[(m || 1) - 1]} ${d}, ${y}`;
}

function formatMonthYear(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_LONG[(m || 1) - 1]} ${y}`;
}

function formatTime12h(hm: string): string {
  const [hStr, mStr] = (hm || '00:00').split(':');
  const h = Number(hStr) || 0;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${(mStr || '00').padStart(2, '0')} ${suffix}`;
}

function getDefaultJournalTitle(): string {
  const displayName = (getSetting('display_name') || '').trim();
  if (displayName) {
    return `${displayName}'s Journal`;
  }
  return 'Midline Journal';
}

/**
 * Sanitize text for PDFKit's built-in WinAnsi serif/sans fonts so characters
 * outside WinAnsi (e.g. emojis or exotic symbols) never render as garbled glyphs.
 */
function sanitizePdfText(input: string): string {
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201C|\u201D/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u2014/g, '—')
    .replace(/\u2013/g, '–')
    .replace(/\u00A0/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    // Keep standard printable ASCII, Latin-1 supplement, and WinAnsi punctuation (em/en dash, bullet)
    .replace(/[^\x0A\x20-\x7E\xA0-\xFF\u2013\u2014\u2022]/g, '');
}

export function queryExportEntries(opts: ExportOptions = {}): ExportEntry[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (opts.from && /^\d{4}-\d{2}-\d{2}$/.test(opts.from)) {
    where.push('e.entry_date >= ?');
    params.push(opts.from);
  }
  if (opts.to && /^\d{4}-\d{2}-\d{2}$/.test(opts.to)) {
    where.push('e.entry_date <= ?');
    params.push(opts.to);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const dir = opts.order === 'desc' ? 'DESC' : 'ASC';

  const rows = db
    .prepare(
      `SELECT id, title, content, entry_date, entry_time, mood, energy, prompt_text
       FROM entries e
       ${whereSql}
       ORDER BY e.entry_date ${dir}, e.entry_time ${dir}, e.created_at ${dir}`
    )
    .all(...params) as Omit<ExportEntry, 'tags' | 'photos'>[];

  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const tagRows = db
    .prepare(
      `SELECT et.entry_id, t.name
       FROM entry_tags et
       JOIN tags t ON t.id = et.tag_id
       WHERE et.entry_id IN (${placeholders})
       ORDER BY t.name ASC`
    )
    .all(...ids) as { entry_id: string; name: string }[];

  const photoRows = db
    .prepare(
      `SELECT id, entry_id, filename, original_name, mime_type, caption
       FROM photos
       WHERE entry_id IN (${placeholders})
       ORDER BY sort_order ASC, created_at ASC`
    )
    .all(...ids) as (ExportPhoto & { entry_id: string })[];

  const tagsByEntry = new Map<string, string[]>();
  for (const tr of tagRows) {
    const list = tagsByEntry.get(tr.entry_id) || [];
    list.push(tr.name);
    tagsByEntry.set(tr.entry_id, list);
  }

  const photosByEntry = new Map<string, ExportPhoto[]>();
  for (const pr of photoRows) {
    const list = photosByEntry.get(pr.entry_id) || [];
    list.push({
      id: pr.id,
      filename: pr.filename,
      original_name: pr.original_name,
      mime_type: pr.mime_type,
      caption: pr.caption,
    });
    photosByEntry.set(pr.entry_id, list);
  }

  return rows.map((r) => ({
    ...r,
    tags: tagsByEntry.get(r.id) || [],
    photos: photosByEntry.get(r.id) || [],
  }));
}

export function buildPlainTextExport(
  entries: ExportEntry[],
  opts: ExportOptions = {}
): string {
  const journalTitle = (opts.title || '').trim() || getDefaultJournalTitle();
  const now = new Date();
  const exportedYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(now.getDate()).padStart(2, '0')}`;

  const sortedDates = entries.map((e) => e.entry_date).sort();
  const dateRange =
    sortedDates.length > 0
      ? sortedDates[0] === sortedDates[sortedDates.length - 1]
        ? formatMonthDayYear(sortedDates[0])
        : `${formatMonthDayYear(sortedDates[0])} – ${formatMonthDayYear(
            sortedDates[sortedDates.length - 1]
          )}`
      : 'No entries';

  const lines: string[] = [
    journalTitle.toUpperCase(),
    `Exported from Midline on ${formatMonthDayYear(exportedYmd)}`,
    `Entries: ${entries.length}  |  Date Range: ${dateRange}`,
    '',
  ];

  const sep = '================================================================';

  for (const entry of entries) {
    lines.push(sep);
    lines.push(`Date: ${formatLongDate(entry.entry_date)} at ${formatTime12h(entry.entry_time)}`);
    if (entry.title.trim()) {
      lines.push(`Title: ${entry.title.trim()}`);
    }
    if (entry.prompt_text && entry.prompt_text.trim()) {
      lines.push(`Prompt: ${entry.prompt_text.trim()}`);
    }
    if (entry.mood) {
      const meta = MOOD_META[entry.mood];
      lines.push(`Mood: ${meta ? meta.label : entry.mood}`);
    }
    if (entry.energy !== null && entry.energy !== undefined) {
      lines.push(`Energy: ${entry.energy}/5`);
    }
    if (entry.tags.length > 0) {
      lines.push(`Tags: ${entry.tags.map((t) => `#${t}`).join(', ')}`);
    }
    lines.push(sep);
    lines.push('');
    lines.push(entry.content.trim());

    if (entry.photos.length > 0) {
      lines.push('');
      const photoLabels = entry.photos.map((p) =>
        p.caption.trim() ? `${p.caption.trim()} (${p.original_name})` : p.original_name
      );
      lines.push(`[Photos: ${photoLabels.join('; ')}]`);
    }

    lines.push('');
    lines.push('');
  }

  return lines.join('\n');
}

interface PreparedPhoto {
  buffer: Buffer;
  width: number;
  height: number;
  caption: string;
}

async function preparePhotoForPdf(photo: ExportPhoto): Promise<PreparedPhoto | null> {
  const filePath = path.join(UPLOADS_DIR, photo.filename);
  if (!fs.existsSync(filePath)) return null;

  try {
    const pipeline = sharp(filePath)
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 86, mozjpeg: true });

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (!info.width || !info.height) return null;
    return {
      buffer: data,
      width: info.width,
      height: info.height,
      caption: sanitizePdfText(photo.caption || '').trim(),
    };
  } catch (err) {
    console.warn('Skipping unreadable photo in PDF export:', photo.filename, err);
    return null;
  }
}

export async function buildJournalPdf(
  entries: ExportEntry[],
  opts: ExportOptions = {}
): Promise<Buffer> {
  const journalTitle = sanitizePdfText((opts.title || '').trim() || getDefaultJournalTitle());
  const subtitle = sanitizePdfText((opts.subtitle || '').trim());
  const paperStyle = opts.paperStyle === 'white' ? 'white' : 'warm';
  const includePhotos = opts.includePhotos !== false;
  const includeMetadata = opts.includeMetadata !== false;
  const includeToc = opts.includeToc !== false;

  const palette =
    paperStyle === 'warm'
      ? {
          paper: '#FAF6EE',
          ink: '#23201C',
          muted: '#6E675D',
          subtle: '#948B7E',
          rule: '#DDD3C4',
          accent: '#B86F1C',
          calloutBg: '#F2E9DB',
          photoMat: '#FFFDF9',
        }
      : {
          paper: '#FFFFFF',
          ink: '#1E1D1B',
          muted: '#64605A',
          subtle: '#8B867E',
          rule: '#E0DCD5',
          accent: '#B86F1C',
          calloutBg: '#F6F4F0',
          photoMat: '#FFFFFF',
        };

  const PAGE_W = 612; // US Letter
  const PAGE_H = 792;
  const MARGIN_X = 64;
  const MARGIN_TOP = 68;
  const MARGIN_BOTTOM = 64;
  const CONTENT_W = PAGE_W - MARGIN_X * 2; // 484pt
  const CONTENT_BOTTOM = PAGE_H - MARGIN_BOTTOM;

  const doc = new PDFDocument({
    size: 'LETTER',
    bufferPages: true,
    autoFirstPage: false,
    margins: {
      top: MARGIN_TOP,
      bottom: MARGIN_BOTTOM,
      left: MARGIN_X,
      right: MARGIN_X,
    },
    info: {
      Title: journalTitle,
      Author: (getSetting('display_name') || 'Midline Journal').trim(),
      Creator: 'Midline Journal',
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const donePromise = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // Track chapter header label for every page so running headers show the right Month Year
  const pageChapterLabels: string[] = [];
  let currentChapterLabel = '';

  const addStyledPage = (chapterLabel?: string) => {
    if (chapterLabel !== undefined) {
      currentChapterLabel = chapterLabel;
    }
    doc.addPage();
    pageChapterLabels.push(currentChapterLabel);

    if (paperStyle === 'warm') {
      doc.save();
      doc.rect(0, 0, PAGE_W, PAGE_H).fill(palette.paper);
      doc.restore();
    }
    doc.fillColor(palette.ink);
    doc.y = MARGIN_TOP;
  };

  const ensureSpace = (neededHeight: number) => {
    if (doc.y + neededHeight > CONTENT_BOTTOM) {
      addStyledPage();
    }
  };

  // Compute stats for cover page
  const sortedDates = entries.map((e) => e.entry_date).sort();
  const uniqueDays = new Set(sortedDates).size;
  const totalPhotos = includePhotos
    ? entries.reduce((sum, e) => sum + e.photos.length, 0)
    : 0;
  const dateRangeStr =
    sortedDates.length > 0
      ? sortedDates[0] === sortedDates[sortedDates.length - 1]
        ? formatMonthDayYear(sortedDates[0])
        : `${formatMonthDayYear(sortedDates[0])}  —  ${formatMonthDayYear(
            sortedDates[sortedDates.length - 1]
          )}`
      : 'No entries in selected range';

  const now = new Date();
  const exportedYmd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(
    2,
    '0'
  )}-${String(now.getDate()).padStart(2, '0')}`;

  // =========================================================================
  // PAGE 1: BOOK TITLE / COVER PAGE
  // =========================================================================
  addStyledPage('');

  // Outer & inner decorative book border
  doc.save();
  doc
    .lineWidth(0.75)
    .strokeColor(palette.rule)
    .rect(38, 38, PAGE_W - 76, PAGE_H - 76)
    .stroke();
  doc
    .lineWidth(0.5)
    .strokeColor(palette.rule)
    .rect(44, 44, PAGE_W - 88, PAGE_H - 88)
    .stroke();

  // Subtle corner amber accents
  const cornerLen = 18;
  doc.lineWidth(1.5).strokeColor(palette.accent);
  // Top-left
  doc.moveTo(44, 44 + cornerLen).lineTo(44, 44).lineTo(44 + cornerLen, 44).stroke();
  // Top-right
  doc
    .moveTo(PAGE_W - 44 - cornerLen, 44)
    .lineTo(PAGE_W - 44, 44)
    .lineTo(PAGE_W - 44, 44 + cornerLen)
    .stroke();
  // Bottom-left
  doc
    .moveTo(44, PAGE_H - 44 - cornerLen)
    .lineTo(44, PAGE_H - 44)
    .lineTo(44 + cornerLen, PAGE_H - 44)
    .stroke();
  // Bottom-right
  doc
    .moveTo(PAGE_W - 44 - cornerLen, PAGE_H - 44)
    .lineTo(PAGE_W - 44, PAGE_H - 44)
    .lineTo(PAGE_W - 44, PAGE_H - 44 - cornerLen)
    .stroke();
  doc.restore();

  // Top eyebrow
  doc
    .font('Helvetica-Bold')
    .fontSize(9)
    .fillColor(palette.accent)
    .text('M I D L I N E   J O U R N A L', MARGIN_X, 140, {
      width: CONTENT_W,
      align: 'center',
      characterSpacing: 1.8,
    });

  // Main Title
  doc
    .font('Times-Bold')
    .fontSize(34)
    .fillColor(palette.ink)
    .text(journalTitle, MARGIN_X, 255, {
      width: CONTENT_W,
      align: 'center',
    });

  let coverY = doc.y + 12;

  if (subtitle) {
    doc
      .font('Times-Italic')
      .fontSize(14)
      .fillColor(palette.muted)
      .text(subtitle, MARGIN_X + 30, coverY, {
        width: CONTENT_W - 60,
        align: 'center',
      });
    coverY = doc.y + 18;
  } else {
    coverY += 8;
  }

  // Ornamental amber rule
  doc.save();
  doc
    .lineWidth(1.5)
    .strokeColor(palette.accent)
    .moveTo(PAGE_W / 2 - 36, coverY)
    .lineTo(PAGE_W / 2 + 36, coverY)
    .stroke();
  doc.restore();

  // Date span
  doc
    .font('Times-Roman')
    .fontSize(13)
    .fillColor(palette.ink)
    .text(dateRangeStr, MARGIN_X, coverY + 26, {
      width: CONTENT_W,
      align: 'center',
    });

  // Stats summary
  const statParts = [
    `${entries.length} ${entries.length === 1 ? 'Entry' : 'Entries'}`,
    `${uniqueDays} ${uniqueDays === 1 ? 'Day' : 'Days'}`,
  ];
  if (includePhotos && totalPhotos > 0) {
    statParts.push(`${totalPhotos} ${totalPhotos === 1 ? 'Photo' : 'Photos'}`);
  }
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor(palette.muted)
    .text(statParts.join('   •   '), MARGIN_X, doc.y + 14, {
      width: CONTENT_W,
      align: 'center',
    });

  // Bottom colophon on cover
  doc
    .font('Helvetica')
    .fontSize(8.5)
    .fillColor(palette.subtle)
    .text(
      `Private Edition   •   Exported ${formatMonthDayYear(exportedYmd)}`,
      MARGIN_X,
      PAGE_H - 96,
      {
        width: CONTENT_W,
        align: 'center',
      }
    );

  // =========================================================================
  // DETERMINE CHAPTERS (BY YYYY-MM) & RESERVE TOC PAGES IF NEEDED
  // =========================================================================
  interface ChapterInfo {
    ym: string;
    label: string;
    entryCount: number;
    startPageNumber: number; // 1-based printed page number (excluding cover)
  }

  const chapterOrder: ChapterInfo[] = [];
  const chapterMap = new Map<string, ChapterInfo>();
  for (const e of entries) {
    const ym = e.entry_date.slice(0, 7);
    let ch = chapterMap.get(ym);
    if (!ch) {
      ch = {
        ym,
        label: formatMonthYear(ym),
        entryCount: 0,
        startPageNumber: 0,
      };
      chapterMap.set(ym, ch);
      chapterOrder.push(ch);
    }
    ch.entryCount++;
  }

  const shouldRenderToc = includeToc && chapterOrder.length >= 2;
  const tocPageIndices: number[] = [];
  const TOC_ROWS_PER_PAGE = 26;

  if (shouldRenderToc) {
    const tocPagesNeeded = Math.ceil(chapterOrder.length / TOC_ROWS_PER_PAGE);
    for (let i = 0; i < tocPagesNeeded; i++) {
      addStyledPage('Contents');
      tocPageIndices.push(pageChapterLabels.length - 1);
    }
  }

  // =========================================================================
  // JOURNAL ENTRIES
  // =========================================================================
  if (entries.length === 0) {
    addStyledPage('Journal');
    doc
      .font('Times-Italic')
      .fontSize(13)
      .fillColor(palette.muted)
      .text('No journal entries found for the selected date range.', MARGIN_X, 260, {
        width: CONTENT_W,
        align: 'center',
      });
  } else {
    let activeYm = '';

    for (let idx = 0; idx < entries.length; idx++) {
      const entry = entries[idx];
      const ym = entry.entry_date.slice(0, 7);
      const isNewChapter = ym !== activeYm;

      if (isNewChapter) {
        activeYm = ym;
        const ch = chapterMap.get(ym)!;
        const chapterLabel = ch.label;

        if (idx === 0) {
          addStyledPage(chapterLabel);
        } else if (doc.y > CONTENT_BOTTOM - 210) {
          addStyledPage(chapterLabel);
        } else {
          // Update current chapter label and add breathing room before new month divider
          currentChapterLabel = chapterLabel;
          doc.y += 14;
        }

        // Record the 1-based page number (after cover page)
        ch.startPageNumber = pageChapterLabels.length - 1;

        // Chapter Month / Year Banner
        const bannerY = doc.y;
        doc
          .font('Helvetica-Bold')
          .fontSize(10.5)
          .fillColor(palette.accent)
          .text(chapterLabel.toUpperCase(), MARGIN_X, bannerY, {
            width: CONTENT_W * 0.72,
            characterSpacing: 1.4,
          });

        doc
          .font('Helvetica')
          .fontSize(8.5)
          .fillColor(palette.subtle)
          .text(
            `${ch.entryCount} ${ch.entryCount === 1 ? 'entry' : 'entries'}`,
            MARGIN_X,
            bannerY + 1,
            {
              width: CONTENT_W,
              align: 'right',
            }
          );

        const ruleY = bannerY + 18;
        doc.save();
        doc
          .lineWidth(1)
          .strokeColor(palette.accent)
          .moveTo(MARGIN_X, ruleY)
          .lineTo(MARGIN_X + 42, ruleY)
          .stroke();
        doc
          .lineWidth(0.5)
          .strokeColor(palette.rule)
          .moveTo(MARGIN_X + 42, ruleY)
          .lineTo(MARGIN_X + CONTENT_W, ruleY)
          .stroke();
        doc.restore();

        doc.y = ruleY + 20;
      }

      // Ensure at least ~105pt before starting an entry header so date isn't orphaned
      ensureSpace(105);

      // Entry Date & Time header
      const entryTopY = doc.y;
      const dateLabel = formatLongDate(entry.entry_date);
      const timeLabel = formatTime12h(entry.entry_time);

      doc
        .font('Times-Bold')
        .fontSize(12.5)
        .fillColor(palette.ink)
        .text(dateLabel, MARGIN_X, entryTopY, {
          width: CONTENT_W - 72,
        });

      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(palette.muted)
        .text(timeLabel, MARGIN_X + CONTENT_W - 70, entryTopY + 2.5, {
          width: 70,
          align: 'right',
        });

      doc.y = Math.max(doc.y, entryTopY + 17);

      // Metadata line: Mood dot + label, Energy, Tags
      if (includeMetadata) {
        const hasMood = Boolean(entry.mood);
        const hasEnergy = entry.energy !== null && entry.energy !== undefined;
        const hasTags = entry.tags.length > 0;

        if (hasMood || hasEnergy || hasTags) {
          const metaY = doc.y + 2;
          let cursorX = MARGIN_X;

          if (hasMood && entry.mood) {
            const moodMeta = MOOD_META[entry.mood];
            const dotColor = moodMeta ? moodMeta.color : palette.accent;
            const moodText = moodMeta ? moodMeta.label : entry.mood;

            doc.save();
            doc.circle(cursorX + 3.5, metaY + 4.5, 3).fill(dotColor);
            doc.restore();
            cursorX += 11;

            doc
              .font('Helvetica-Bold')
              .fontSize(8.5)
              .fillColor(palette.muted)
              .text(moodText, cursorX, metaY, { lineBreak: false });
            cursorX += doc.widthOfString(moodText) + 12;
          }

          if (hasEnergy) {
            const energyText = `Energy ${entry.energy}/5`;
            doc
              .font('Helvetica')
              .fontSize(8.5)
              .fillColor(palette.muted)
              .text(energyText, cursorX, metaY, { lineBreak: false });
            cursorX += doc.widthOfString(energyText) + 12;
          }

          if (hasTags) {
            const tagsText = sanitizePdfText(entry.tags.map((t) => `#${t}`).join('  '));
            const remainingW = Math.max(80, MARGIN_X + CONTENT_W - cursorX);
            doc
              .font('Helvetica')
              .fontSize(8.5)
              .fillColor(palette.subtle)
              .text(tagsText, cursorX, metaY, {
                width: remainingW,
              });
          }

          doc.y = Math.max(doc.y, metaY + 13);
        }
      }

      // Optional Entry Title
      const cleanTitle = sanitizePdfText(entry.title || '').trim();
      if (cleanTitle) {
        doc.y += 5;
        ensureSpace(34);
        doc
          .font('Times-Bold')
          .fontSize(15)
          .fillColor(palette.ink)
          .text(cleanTitle, MARGIN_X, doc.y, {
            width: CONTENT_W,
          });
      }

      // Optional Prompt Callout Box
      const cleanPrompt = sanitizePdfText(entry.prompt_text || '').trim();
      if (includeMetadata && cleanPrompt) {
        doc.y += 8;
        doc.font('Times-Italic').fontSize(10.5);
        const promptTextH = doc.heightOfString(cleanPrompt, {
          width: CONTENT_W - 24,
          lineGap: 2.5,
        });
        const boxH = promptTextH + 26;
        ensureSpace(boxH + 8);

        const boxY = doc.y;
        doc.save();
        doc.roundedRect(MARGIN_X, boxY, CONTENT_W, boxH, 3).fill(palette.calloutBg);
        doc.rect(MARGIN_X, boxY, 3, boxH).fill(palette.accent);
        doc.restore();

        doc
          .font('Helvetica-Bold')
          .fontSize(7)
          .fillColor(palette.accent)
          .text('PROMPT', MARGIN_X + 12, boxY + 7, {
            characterSpacing: 1.1,
          });

        doc
          .font('Times-Italic')
          .fontSize(10.5)
          .fillColor(palette.muted)
          .text(cleanPrompt, MARGIN_X + 12, boxY + 18, {
            width: CONTENT_W - 24,
            lineGap: 2.5,
          });

        doc.y = boxY + boxH + 4;
      }

      // Entry Body Content
      const cleanContent = sanitizePdfText(entry.content || '').trim();
      if (cleanContent) {
        doc.y += 9;
        const paragraphs = cleanContent.split(/\n{2,}/);
        doc.font('Times-Roman').fontSize(11.2).fillColor(palette.ink);

        for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
          const para = paragraphs[pIdx].trim();
          if (!para) continue;

          // If near page bottom, avoid starting a single orphaned line
          if (doc.y > CONTENT_BOTTOM - 28) {
            addStyledPage();
          }

          doc.text(para, MARGIN_X, doc.y, {
            width: CONTENT_W,
            lineGap: 4.2,
            paragraphGap: pIdx < paragraphs.length - 1 ? 8 : 0,
            align: 'left',
          });
        }
      }

      // Entry Photos
      if (includePhotos && entry.photos.length > 0) {
        const prepared: PreparedPhoto[] = [];
        for (const photo of entry.photos) {
          const p = await preparePhotoForPdf(photo);
          if (p) prepared.push(p);
        }

        if (prepared.length === 1) {
          const p = prepared[0];
          const maxW = CONTENT_W * 0.78;
          const maxH = 260;
          const scale = Math.min(maxW / p.width, maxH / p.height, 1);
          const drawW = p.width * scale;
          const drawH = p.height * scale;
          const captionH = p.caption
            ? doc
                .font('Times-Italic')
                .fontSize(9)
                .heightOfString(p.caption, { width: drawW }) + 8
            : 0;
          const pad = 5;
          const totalBlockH = drawH + pad * 2 + captionH + 16;

          ensureSpace(totalBlockH);
          doc.y += 12;

          const imgX = MARGIN_X + (CONTENT_W - drawW) / 2;
          const imgY = doc.y + pad;

          doc.save();
          doc
            .rect(imgX - pad, imgY - pad, drawW + pad * 2, drawH + pad * 2)
            .fillAndStroke(palette.photoMat, palette.rule);
          doc.restore();

          doc.image(p.buffer, imgX, imgY, { width: drawW, height: drawH });
          doc.y = imgY + drawH + pad;

          if (p.caption) {
            doc
              .font('Times-Italic')
              .fontSize(9)
              .fillColor(palette.muted)
              .text(p.caption, imgX, doc.y + 5, {
                width: drawW,
                align: 'center',
              });
          }
        } else if (prepared.length > 1) {
          doc.y += 12;
          const gutter = 14;
          const cellW = (CONTENT_W - gutter) / 2;
          const pad = 4;
          const maxImgW = cellW - pad * 2;
          const maxImgH = 180;

          for (let i = 0; i < prepared.length; i += 2) {
            const pair = prepared.slice(i, i + 2);
            const metrics = pair.map((p) => {
              const scale = Math.min(maxImgW / p.width, maxImgH / p.height, 1);
              const drawW = p.width * scale;
              const drawH = p.height * scale;
              const capH = p.caption
                ? doc
                    .font('Times-Italic')
                    .fontSize(8.5)
                    .heightOfString(p.caption, { width: cellW }) + 6
                : 0;
              return { p, drawW, drawH, capH };
            });

            const rowImgH = Math.max(...metrics.map((m) => m.drawH));
            const rowCapH = Math.max(...metrics.map((m) => m.capH));
            const rowTotalH = rowImgH + pad * 2 + rowCapH + 12;

            ensureSpace(rowTotalH);
            const rowY = doc.y;

            for (let col = 0; col < metrics.length; col++) {
              const m = metrics[col];
              // If odd last photo, center it neatly
              const cellX =
                metrics.length === 1
                  ? MARGIN_X + (CONTENT_W - cellW) / 2
                  : MARGIN_X + col * (cellW + gutter);

              const imgX = cellX + (cellW - m.drawW) / 2;
              const imgY = rowY + pad + (rowImgH - m.drawH) / 2;

              doc.save();
              doc
                .rect(imgX - pad, imgY - pad, m.drawW + pad * 2, m.drawH + pad * 2)
                .fillAndStroke(palette.photoMat, palette.rule);
              doc.restore();

              doc.image(m.p.buffer, imgX, imgY, { width: m.drawW, height: m.drawH });

              if (m.p.caption) {
                doc
                  .font('Times-Italic')
                  .fontSize(8.5)
                  .fillColor(palette.muted)
                  .text(m.p.caption, cellX, rowY + rowImgH + pad * 2 + 4, {
                    width: cellW,
                    align: 'center',
                  });
              }
            }

            doc.y = rowY + rowTotalH;
          }
        }
      }

      // Ornamental divider between entries (unless next entry starts a new chapter or is last)
      const nextEntry = entries[idx + 1];
      if (nextEntry && nextEntry.entry_date.slice(0, 7) === ym) {
        if (doc.y + 34 < CONTENT_BOTTOM) {
          doc.y += 14;
          doc
            .font('Times-Roman')
            .fontSize(10)
            .fillColor(palette.subtle)
            .text('•     •     •', MARGIN_X, doc.y, {
              width: CONTENT_W,
              align: 'center',
            });
          doc.y += 14;
        } else {
          addStyledPage();
        }
      } else if (nextEntry) {
        doc.y += 18;
      }
    }

    // Closing ornament after final entry
    if (doc.y + 44 < CONTENT_BOTTOM) {
      doc.y += 24;
      doc
        .font('Times-Italic')
        .fontSize(10)
        .fillColor(palette.subtle)
        .text('—  End of Journal  —', MARGIN_X, doc.y, {
          width: CONTENT_W,
          align: 'center',
        });
    }
  }

  // =========================================================================
  // FILL IN TABLE OF CONTENTS PAGES WITH EXACT PAGE NUMBERS
  // =========================================================================
  if (shouldRenderToc && tocPageIndices.length > 0) {
    for (let tPage = 0; tPage < tocPageIndices.length; tPage++) {
      doc.switchToPage(tocPageIndices[tPage]);
      const slice = chapterOrder.slice(
        tPage * TOC_ROWS_PER_PAGE,
        (tPage + 1) * TOC_ROWS_PER_PAGE
      );

      let y = MARGIN_TOP + 6;
      if (tPage === 0) {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(palette.accent)
          .text('CONTENTS', MARGIN_X, y, {
            width: CONTENT_W,
            characterSpacing: 1.6,
          });
        y += 16;
        doc
          .font('Times-Bold')
          .fontSize(20)
          .fillColor(palette.ink)
          .text('Chapters by Month', MARGIN_X, y, { width: CONTENT_W });
        y += 30;
        doc.save();
        doc
          .lineWidth(0.75)
          .strokeColor(palette.rule)
          .moveTo(MARGIN_X, y)
          .lineTo(MARGIN_X + CONTENT_W, y)
          .stroke();
        doc.restore();
        y += 18;
      } else {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .fillColor(palette.accent)
          .text('CONTENTS (CONTINUED)', MARGIN_X, y, {
            width: CONTENT_W,
            characterSpacing: 1.4,
          });
        y += 26;
      }

      for (const ch of slice) {
        const leftText = ch.label;
        const countText = `${ch.entryCount} ${ch.entryCount === 1 ? 'entry' : 'entries'}`;
        const pageNumText = String(ch.startPageNumber);

        doc.font('Times-Roman').fontSize(11.5).fillColor(palette.ink);
        doc.text(leftText, MARGIN_X, y, { lineBreak: false });
        const leftW = doc.widthOfString(leftText);

        doc.font('Helvetica').fontSize(8.5).fillColor(palette.subtle);
        const countX = MARGIN_X + leftW + 10;
        doc.text(`(${countText})`, countX, y + 2, { lineBreak: false });
        const countW = doc.widthOfString(`(${countText})`);

        doc.font('Times-Bold').fontSize(11).fillColor(palette.ink);
        const pageNumW = doc.widthOfString(pageNumText);
        doc.text(pageNumText, MARGIN_X + CONTENT_W - pageNumW, y, { lineBreak: false });

        // Dotted leader line
        const dotStart = countX + countW + 10;
        const dotEnd = MARGIN_X + CONTENT_W - pageNumW - 10;
        if (dotEnd > dotStart + 12) {
          doc.save();
          doc
            .lineWidth(0.5)
            .strokeColor(palette.rule)
            .dash(1.5, { space: 3.5 })
            .moveTo(dotStart, y + 9.5)
            .lineTo(dotEnd, y + 9.5)
            .stroke();
          doc.restore();
        }

        y += 22;
      }
    }
  }

  // =========================================================================
  // RUNNING HEADERS & FOOTERS ON ALL PAGES AFTER COVER
  // =========================================================================
  const range = doc.bufferedPageRange();
  for (let i = 1; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    const chapterHeader = pageChapterLabels[i] || '';

    // Temporarily disable bottom margin clipping while drawing header/footer
    const prevBottom = doc.page.margins.bottom;
    const prevTop = doc.page.margins.top;
    doc.page.margins.top = 0;
    doc.page.margins.bottom = 0;

    // Header
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(palette.subtle)
      .text(journalTitle, MARGIN_X, 34, {
        width: CONTENT_W * 0.6,
        lineBreak: false,
      });

    if (chapterHeader) {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(palette.subtle)
        .text(chapterHeader, MARGIN_X, 34, {
          width: CONTENT_W,
          align: 'right',
          lineBreak: false,
        });
    }

    doc.save();
    doc
      .lineWidth(0.5)
      .strokeColor(palette.rule)
      .moveTo(MARGIN_X, 48)
      .lineTo(MARGIN_X + CONTENT_W, 48)
      .stroke();
    doc.restore();

    // Footer
    doc.save();
    doc
      .lineWidth(0.5)
      .strokeColor(palette.rule)
      .moveTo(MARGIN_X, PAGE_H - 48)
      .lineTo(MARGIN_X + CONTENT_W, PAGE_H - 48)
      .stroke();
    doc.restore();

    doc
      .font('Times-Roman')
      .fontSize(9)
      .fillColor(palette.muted)
      .text(String(i), MARGIN_X, PAGE_H - 38, {
        width: CONTENT_W,
        align: 'center',
        lineBreak: false,
      });

    doc.page.margins.top = prevTop;
    doc.page.margins.bottom = prevBottom;
  }

  doc.end();
  return donePromise;
}
