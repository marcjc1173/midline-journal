import { extractText, getDocumentProxy } from 'unpdf';
import { db } from '../db.js';

export interface ParsedImportEntry {
  entry_date: string; // YYYY-MM-DD
  entry_time: string; // HH:MM
  title: string;
  content: string;
  mood: string | null;
  energy: number | null;
  prompt_text: string | null;
  tags: string[];
  isDuplicate?: boolean;
}

export interface ImportPreviewResult {
  detectedFormat: string;
  totalParsed: number;
  duplicateCount: number;
  dateRange: { from: string; to: string } | null;
  warnings: string[];
  entries: ParsedImportEntry[];
}

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const MOOD_SYNONYMS: Record<string, string> = {
  good: 'good',
  great: 'good',
  happy: 'good',
  joyful: 'good',
  upbeat: 'good',
  positive: 'good',
  steady: 'steady',
  calm: 'steady',
  okay: 'steady',
  ok: 'steady',
  neutral: 'steady',
  peaceful: 'steady',
  content: 'steady',
  grounded: 'steady',
  grateful: 'grateful',
  thankful: 'grateful',
  blessed: 'grateful',
  appreciative: 'grateful',
  stressed: 'stressed',
  anxious: 'stressed',
  overwhelmed: 'stressed',
  tense: 'stressed',
  worried: 'stressed',
  frustrated: 'stressed',
  heavy: 'heavy',
  tired: 'heavy',
  exhausted: 'heavy',
  drained: 'heavy',
  reflective: 'heavy',
  low: 'low',
  sad: 'low',
  down: 'low',
  lonely: 'low',
  depressed: 'low',
  rough: 'low',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function getTodayYmd(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

function isValidYmd(y: number, m: number, d: number): boolean {
  if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

function parseTimePart(raw: string): string | null {
  const m = raw.match(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.)?\b/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  if (minute < 0 || minute > 59) return null;

  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour < 0 || hour > 23) return null;

  return `${pad2(hour)}:${pad2(minute)}`;
}

interface ParsedDateHeader {
  date: string; // YYYY-MM-DD
  time: string | null; // HH:MM
  trailingText: string; // anything left on the line after date/time
}

function looksLikeDateRange(rest: string): boolean {
  const trimmed = rest.trim();
  if (!/^[\s—–-]+/.test(trimmed)) return false;
  const afterDash = trimmed.replace(/^[\s—–-]+/, '').trim();
  return /^(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{4})/i.test(
    afterDash
  );
}

/**
 * Attempts to parse a line as an entry date header.
 * Supports Clearful, Midline, Day One, Markdown headings, and common US/ISO/EU date formats.
 */
function parseDateHeaderLine(rawLine: string): ParsedDateHeader | null {
  let line = rawLine.trim();
  if (!line || line.length > 140) return null;

  // Strip leading markdown heading hashes, bold/italic markers, or "Date:" prefix
  line = line.replace(/^#{1,4}\s*/, '').replace(/^\*{1,2}(.+?)\*{1,2}$/, '$1').trim();
  const hadDatePrefix = /^date\s*:\s*/i.test(line);
  if (hadDatePrefix) {
    line = line.replace(/^date\s*:\s*/i, '').trim();
  }

  // Strip optional leading weekday name: "Thursday, " or "Thu "
  const weekdayStripped = line.replace(
    /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[,\s]+/i,
    ''
  );

  // Pattern 1: "October 24, 2026 [at 08:15 AM]" or "Oct 24 2026, 8:15 PM"
  const p1 = weekdayStripped.match(
    /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(.*)$/i
  );
  if (p1) {
    const month = MONTH_MAP[p1[1].toLowerCase()];
    const day = Number(p1[2]);
    const year = Number(p1[3]);
    if (month && isValidYmd(year, month, day)) {
      const rest = p1[4].trim();
      if (!hadDatePrefix && looksLikeDateRange(rest)) return null;
      const time = parseTimePart(rest);
      const trailing = stripTimePrefix(rest);
      // Avoid false positives in mid-sentence prose unless prefixed with Date: or short/clean header
      if (hadDatePrefix || trailing.length <= 50) {
        return { date: `${year}-${pad2(month)}-${pad2(day)}`, time, trailingText: trailing };
      }
    }
  }

  // Pattern 2: "24 October 2026 [at 8:15 AM]"
  const p2 = weekdayStripped.match(
    /^(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(\d{4})(.*)$/i
  );
  if (p2) {
    const day = Number(p2[1]);
    const month = MONTH_MAP[p2[2].toLowerCase()];
    const year = Number(p2[3]);
    if (month && isValidYmd(year, month, day)) {
      const rest = p2[4].trim();
      if (!hadDatePrefix && looksLikeDateRange(rest)) return null;
      const time = parseTimePart(rest);
      const trailing = stripTimePrefix(rest);
      if (hadDatePrefix || trailing.length <= 50) {
        return { date: `${year}-${pad2(month)}-${pad2(day)}`, time, trailingText: trailing };
      }
    }
  }

  // Pattern 3: ISO "2026-10-24" or "2026/10/24" with optional time
  const p3 = weekdayStripped.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(.*)$/);
  if (p3) {
    const year = Number(p3[1]);
    const month = Number(p3[2]);
    const day = Number(p3[3]);
    if (isValidYmd(year, month, day)) {
      const rest = p3[4].trim();
      if (!hadDatePrefix && looksLikeDateRange(rest)) return null;
      const time = parseTimePart(rest);
      const trailing = stripTimePrefix(rest);
      if (hadDatePrefix || trailing.length <= 50) {
        return { date: `${year}-${pad2(month)}-${pad2(day)}`, time, trailingText: trailing };
      }
    }
  }

  // Pattern 4: US numeric "10/24/2026" or "10-24-2026"
  const p4 = weekdayStripped.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(.*)$/);
  if (p4) {
    const month = Number(p4[1]);
    const day = Number(p4[2]);
    const year = Number(p4[3]);
    if (isValidYmd(year, month, day)) {
      const rest = p4[4].trim();
      if (!hadDatePrefix && looksLikeDateRange(rest)) return null;
      const time = parseTimePart(rest);
      const trailing = stripTimePrefix(rest);
      if (hadDatePrefix || trailing.length <= 50) {
        return { date: `${year}-${pad2(month)}-${pad2(day)}`, time, trailingText: trailing };
      }
    }
  }

  return null;
}

function stripTimePrefix(rest: string): string {
  return rest
    .replace(
      /^[\s,|•·—–@-]*(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?/i,
      ''
    )
    .replace(/^[\s,|•·—–-]+/, '')
    .trim();
}

function isStandaloneTimeLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 20) return null;
  if (/^(?:at\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?$/i.test(trimmed)) {
    return parseTimePart(trimmed);
  }
  return null;
}

function isSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  return /^([=\-_~*•·])\1{2,}$/.test(trimmed) || /^[•·](\s+[•·]){2,}$/.test(trimmed);
}

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  // Page footers from PDF exports (e.g. "Page 3 of 12", "3 / 12", or lone small page number)
  if (/^page\s+\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(trimmed)) return true;
  if (/^—\s*end of journal\s*—$/i.test(trimmed)) return true;
  if (/^exported from midline on /i.test(trimmed)) return true;
  return false;
}

function normalizeMood(raw: string): string | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z\s]/g, '').trim();
  if (!cleaned) return null;
  if (MOOD_SYNONYMS[cleaned]) return MOOD_SYNONYMS[cleaned];
  const firstWord = cleaned.split(/\s+/)[0];
  return MOOD_SYNONYMS[firstWord] || null;
}

function parseTagsValue(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((t) => t.trim().toLowerCase().replace(/^#/, ''))
        .filter((t) => t.length > 0 && t.length <= 40)
    ),
  ];
}

function normalizeForDuplicateKey(date: string, title: string, content: string): string {
  const norm = `${title} ${content}`
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
  return `${date}::${norm}`;
}

export async function extractTextFromUploadedFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<{ text: string; sourceType: 'pdf' | 'text' }> {
  const lower = filename.toLowerCase();
  const isPdf = lower.endsWith('.pdf') || mimeType === 'application/pdf';

  if (isPdf) {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [String(result.text || '')];
    return {
      text: pages.join('\n\n'),
      sourceType: 'pdf',
    };
  }

  return {
    text: buffer.toString('utf8').replace(/^\uFEFF/, ''),
    sourceType: 'text',
  };
}

export function parseJournalImportText(
  rawText: string,
  sourceType: 'pdf' | 'text' = 'text'
): ImportPreviewResult {
  const warnings: string[] = [];
  const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Scan for all date header line indices
  interface HeaderMatch {
    lineIndex: number;
    header: ParsedDateHeader;
  }

  const headerMatches: HeaderMatch[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isNoiseLine(line) || isSeparatorLine(line)) continue;
    const parsed = parseDateHeaderLine(line);
    if (parsed) {
      headerMatches.push({ lineIndex: i, header: parsed });
    }
  }

  let detectedFormat = sourceType === 'pdf' ? 'PDF Journal Export' : 'Plain Text Journal';
  if (/exported from midline on /i.test(rawText)) {
    detectedFormat = 'Midline Plain Text Export';
  } else if (/title\s*\/\s*prompt\s*:/i.test(rawText) || /clearful/i.test(rawText)) {
    detectedFormat =
      sourceType === 'pdf' ? 'Clearful PDF Export' : 'Clearful Plain Text Export';
  }

  const entries: ParsedImportEntry[] = [];

  if (headerMatches.length === 0) {
    // Fallback: import entire non-empty document as a single entry dated today
    const body = lines
      .filter((l) => !isNoiseLine(l))
      .join('\n')
      .trim();
    if (body) {
      entries.push({
        entry_date: getTodayYmd(),
        entry_time: '12:00',
        title: '',
        content: body,
        mood: null,
        energy: null,
        prompt_text: null,
        tags: [],
      });
      warnings.push(
        'No entry dates were detected in this file. Imported as a single entry dated today — you can edit its date after importing.'
      );
    } else {
      warnings.push('No readable text was found in this file.');
    }
  } else {
    for (let m = 0; m < headerMatches.length; m++) {
      const start = headerMatches[m].lineIndex;
      const end = m + 1 < headerMatches.length ? headerMatches[m + 1].lineIndex : lines.length;
      const header = headerMatches[m].header;

      let entryTime = header.time || '12:00';
      let title = header.trailingText || '';
      let promptText: string | null = null;
      let mood: string | null = null;
      let energy: number | null = null;
      let tags: string[] = [];

      const bodyLines: string[] = [];
      let inHeaderMeta = true;

      for (let i = start + 1; i < end; i++) {
        const rawLine = lines[i];
        const trimmed = rawLine.trim();

        if (isNoiseLine(trimmed)) continue;

        if (inHeaderMeta) {
          if (!trimmed || isSeparatorLine(trimmed)) {
            // Separator or blank line right after header metadata
            continue;
          }

          // Standalone time line right after date line (common in Clearful/Day One)
          if (!header.time) {
            const t = isStandaloneTimeLine(trimmed);
            if (t) {
              entryTime = t;
              continue;
            }
          }

          // Metadata key-value lines
          const titlePromptMatch = trimmed.match(/^title\s*\/\s*prompt\s*:\s*(.+)$/i);
          if (titlePromptMatch) {
            const val = titlePromptMatch[1].trim();
            if (val.endsWith('?')) {
              promptText = val;
            } else {
              title = title ? `${title} — ${val}` : val;
            }
            continue;
          }

          const titleMatch = trimmed.match(/^title\s*:\s*(.+)$/i);
          if (titleMatch) {
            title = titleMatch[1].trim();
            continue;
          }

          const promptMatch = trimmed.match(/^(?:prompt|question)\s*:\s*(.+)$/i);
          if (promptMatch) {
            promptText = promptMatch[1].trim();
            continue;
          }

          const moodMatch = trimmed.match(/^mood\s*:\s*(.+)$/i);
          if (moodMatch) {
            mood = normalizeMood(moodMatch[1]);
            continue;
          }

          const energyMatch = trimmed.match(/^energy\s*:\s*(\d)(?:\s*\/\s*5)?\b/i);
          if (energyMatch) {
            const num = Number(energyMatch[1]);
            if (num >= 1 && num <= 5) energy = num;
            continue;
          }

          const tagsMatch = trimmed.match(/^tags?\s*:\s*(.+)$/i);
          if (tagsMatch) {
            tags = [...new Set([...tags, ...parseTagsValue(tagsMatch[1])])];
            continue;
          }

          // First non-metadata line begins the entry body
          inHeaderMeta = false;
        }

        // Skip trailing separator lines right before the next entry
        if (isSeparatorLine(trimmed)) {
          const remainingNonEmpty = lines
            .slice(i + 1, end)
            .some((l) => l.trim() && !isSeparatorLine(l) && !isNoiseLine(l));
          if (!remainingNonEmpty) continue;
        }

        // Skip Midline plain-text photo reference footer on round-trip
        if (/^\[Photos:\s*.+\]$/.test(trimmed)) {
          continue;
        }

        bodyLines.push(rawLine);
      }

      const content = bodyLines.join('\n').trim();
      if (!content && !title && !promptText) {
        continue;
      }

      entries.push({
        entry_date: header.date,
        entry_time: entryTime,
        title: title.slice(0, 200),
        content,
        mood,
        energy,
        prompt_text: promptText,
        tags,
      });
    }
  }

  // Mark duplicates against existing entries in SQLite
  const existingKeys = loadExistingDuplicateKeys();
  let duplicateCount = 0;
  for (const entry of entries) {
    const key = normalizeForDuplicateKey(entry.entry_date, entry.title, entry.content);
    entry.isDuplicate = existingKeys.has(key);
    if (entry.isDuplicate) duplicateCount++;
  }

  const sortedDates = entries.map((e) => e.entry_date).sort();
  const dateRange =
    sortedDates.length > 0
      ? { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] }
      : null;

  return {
    detectedFormat,
    totalParsed: entries.length,
    duplicateCount,
    dateRange,
    warnings,
    entries,
  };
}

export function loadExistingDuplicateKeys(): Set<string> {
  const rows = db
    .prepare('SELECT entry_date, title, content FROM entries')
    .all() as { entry_date: string; title: string; content: string }[];

  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(normalizeForDuplicateKey(row.entry_date, row.title, row.content));
  }
  return keys;
}

export function buildDuplicateKey(entry: {
  entry_date: string;
  title: string;
  content: string;
}): string {
  return normalizeForDuplicateKey(entry.entry_date, entry.title, entry.content);
}
