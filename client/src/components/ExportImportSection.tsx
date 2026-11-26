import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  ChevronUp,
  FileDown,
  FileText,
  FileUp,
  Loader2,
  X,
} from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import {
  formatShortDate,
  formatTime12h,
  type ImportPreviewResult,
} from '../types';

interface Props {
  onImported?: () => Promise<void> | void;
}

export function ExportImportSection({ onImported }: Props) {
  const { status } = useAuth();
  const defaultTitle = status?.displayName
    ? `${status.displayName}'s Journal`
    : 'Midline Journal';

  // Export state
  const [title, setTitle] = useState(defaultTitle);
  const [subtitle, setSubtitle] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [paperStyle, setPaperStyle] = useState<'warm' | 'white'>('warm');
  const [includePhotos, setIncludePhotos] = useState(true);
  const [includeMetadata, setIncludeMetadata] = useState(true);
  const [includeToc, setIncludeToc] = useState(true);
  const [exportingFormat, setExportingFormat] = useState<'pdf' | 'text' | null>(null);
  const [exportMsg, setExportMsg] = useState('');
  const [exportErr, setExportErr] = useState('');

  // Import state
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [showClearfulHelp, setShowClearfulHelp] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<ImportPreviewResult | null>(null);
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [importTag, setImportTag] = useState('');
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [importErr, setImportErr] = useState('');

  const handleExport = async (format: 'pdf' | 'text') => {
    setExportMsg('');
    setExportErr('');
    if (fromDate && toDate && fromDate > toDate) {
      setExportErr('"From" date must be on or before "To" date.');
      return;
    }
    setExportingFormat(format);
    try {
      await api.exportJournal(format, {
        title: title.trim() || defaultTitle,
        subtitle: subtitle.trim() || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        order,
        paperStyle,
        includePhotos,
        includeMetadata,
        includeToc,
      });
      setExportMsg(
        format === 'pdf'
          ? 'Journal PDF exported.'
          : 'Plain text journal (.txt) exported.'
      );
    } catch (err) {
      setExportErr(err instanceof Error ? err.message : 'Export failed.');
    } finally {
      setExportingFormat(null);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setImportMsg('');
    setImportErr('');
    setPreview(null);
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    if (!file) return;

    setParsing(true);
    try {
      const result = await api.previewImport(file);
      setPreview(result);
      if (result.detectedFormat.toLowerCase().includes('clearful')) {
        setImportTag('clearful');
      } else {
        setImportTag('');
      }
    } catch (err) {
      setImportErr(
        err instanceof Error ? err.message : 'Could not parse the selected file.'
      );
    } finally {
      setParsing(false);
    }
  };

  const handleCancelImport = () => {
    setSelectedFile(null);
    setPreview(null);
    setImportErr('');
    if (importInputRef.current) {
      importInputRef.current.value = '';
    }
  };

  const handleCommitImport = async () => {
    if (!preview || preview.entries.length === 0) return;
    setImportMsg('');
    setImportErr('');
    setImporting(true);
    try {
      const result = await api.commitImport({
        entries: preview.entries,
        skipDuplicates,
        importTag: importTag.trim(),
      });
      const skippedPart =
        result.skipped > 0
          ? ` (${result.skipped} duplicate${result.skipped === 1 ? '' : 's'} skipped)`
          : '';
      setImportMsg(
        `Imported ${result.imported} entr${result.imported === 1 ? 'y' : 'ies'}${skippedPart}.`
      );
      setSelectedFile(null);
      setPreview(null);
      if (importInputRef.current) {
        importInputRef.current.value = '';
      }
      await onImported?.();
    } catch (err) {
      setImportErr(err instanceof Error ? err.message : 'Could not import entries.');
    } finally {
      setImporting(false);
    }
  };

  const entriesToImportCount = preview
    ? skipDuplicates
      ? preview.totalParsed - preview.duplicateCount
      : preview.totalParsed
    : 0;

  return (
    <div className="space-y-6">
      {/* Export Journal */}
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
            <BookOpen className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold">Export Journal</h2>
            <p
              className="mt-0.5 text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              Export your journal as a printable, book-styled PDF with a cover page, monthly
              chapters, and embedded photos — or as a clean plain text (.txt) archive.
            </p>
          </div>
        </div>

        {/* Cover & Date Range Options */}
        <div
          className="rounded-lg border p-4 space-y-3.5"
          style={{
            backgroundColor: 'var(--bg-subtle)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label
                className="block mb-1 text-xs font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Journal Title (Cover Page)
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={defaultTitle}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>
            <div>
              <label
                className="block mb-1 text-xs font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Subtitle (Optional)
              </label>
              <input
                type="text"
                value={subtitle}
                onChange={(e) => setSubtitle(e.target.value)}
                placeholder="e.g. Notes from the Middle Chapter"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label
                className="block mb-1 text-xs font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                From Date (Optional)
              </label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>
            <div>
              <label
                className="block mb-1 text-xs font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                To Date (Optional)
              </label>
              <input
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              />
            </div>
            <div>
              <label
                className="block mb-1 text-xs font-medium"
                style={{ color: 'var(--text-muted)' }}
              >
                Entry Order
              </label>
              <select
                value={order}
                onChange={(e) => setOrder(e.target.value as 'asc' | 'desc')}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  borderColor: 'var(--border)',
                  color: 'var(--text)',
                }}
              >
                <option value="asc">Oldest first (Book order)</option>
                <option value="desc">Newest first</option>
              </select>
            </div>
          </div>

          {/* PDF Styling Options */}
          <div className="pt-1 space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="text-xs font-medium mr-1"
                style={{ color: 'var(--text-muted)' }}
              >
                PDF Paper:
              </span>
              {(
                [
                  { id: 'warm', label: 'Warm Paper' },
                  { id: 'white', label: 'Print White' },
                ] as const
              ).map((opt) => {
                const active = paperStyle === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setPaperStyle(opt.id)}
                    className="rounded-lg border px-2.5 py-1 text-xs font-medium transition"
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

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePhotos}
                  onChange={(e) => setIncludePhotos(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-500"
                />
                <span>Include photos</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeMetadata}
                  onChange={(e) => setIncludeMetadata(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-500"
                />
                <span>Include prompts, mood, energy &amp; tags</span>
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeToc}
                  onChange={(e) => setIncludeToc(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-500"
                />
                <span>Include chapter contents</span>
              </label>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => handleExport('pdf')}
              disabled={exportingFormat !== null}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-stone-950 transition hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent)' }}
            >
              {exportingFormat === 'pdf' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4" />
              )}
              {exportingFormat === 'pdf' ? 'Building Journal PDF…' : 'Export Journal PDF'}
            </button>

            <button
              type="button"
              onClick={() => handleExport('text')}
              disabled={exportingFormat !== null}
              className="inline-flex items-center justify-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition hover:opacity-90 disabled:opacity-50"
              style={{ borderColor: 'var(--border)' }}
            >
              {exportingFormat === 'text' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
              {exportingFormat === 'text' ? 'Exporting…' : 'Export Plain Text (.txt)'}
            </button>
          </div>

          {exportMsg && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
              <Check className="h-3.5 w-3.5" />
              {exportMsg}
            </div>
          )}
          {exportErr && (
            <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
              {exportErr}
            </div>
          )}
        </div>
      </section>

      {/* Import from Another App */}
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
            <FileUp className="h-5 w-5" />
          </div>
          <div className="flex-1">
            <h2 className="text-base font-semibold">Import from Another App</h2>
            <p
              className="mt-0.5 text-xs leading-relaxed"
              style={{ color: 'var(--text-muted)' }}
            >
              Bring your past entries into Midline from <strong>Clearful</strong>, Day One,
              Midline plain text exports, or any dated <code>.txt</code>, <code>.md</code>, or{' '}
              <code>.pdf</code> journal export. You&apos;ll preview every entry before importing.
            </p>
          </div>
        </div>

        {/* Collapsible Clearful Tip */}
        <div>
          <button
            type="button"
            onClick={() => setShowClearfulHelp((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium transition hover:opacity-80"
            style={{ color: 'var(--accent)' }}
          >
            {showClearfulHelp ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
            How to export from Clearful
          </button>
          {showClearfulHelp && (
            <div
              className="mt-2 rounded-lg border px-3.5 py-3 text-xs leading-relaxed space-y-1"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                borderColor: 'var(--border)',
                color: 'var(--text-muted)',
              }}
            >
              <p>
                1. Open <strong>Clearful</strong> → <strong>Settings</strong> →{' '}
                <strong>Account Info</strong> → <strong>Export Journal Entries</strong>.
              </p>
              <p>
                2. Choose <strong>Plain Text (.txt)</strong> (recommended for cleanest formatting)
                or <strong>PDF (.pdf)</strong>.
              </p>
              <p>
                3. Select the exported file below to preview your entries and import them into
                Midline.
              </p>
            </div>
          )}
        </div>

        {/* File Picker */}
        <div
          className="rounded-lg border p-4 space-y-3"
          style={{
            backgroundColor: 'var(--bg-subtle)',
            borderColor: 'var(--border)',
          }}
        >
          <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
            <input
              ref={importInputRef}
              type="file"
              accept=".txt,.md,.markdown,.pdf,text/plain,text/markdown,application/pdf"
              onChange={handleFileChange}
              disabled={parsing || importing}
              className="block w-full text-xs file:mr-3 file:rounded-lg file:border file:border-transparent file:px-3 file:py-1.5 file:text-xs file:font-medium file:cursor-pointer"
              style={{ color: 'var(--text-muted)' }}
            />
            {parsing && (
              <div
                className="inline-flex items-center gap-1.5 text-xs shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Reading file…
              </div>
            )}
          </div>

          {/* Preview Panel */}
          {preview && (
            <div
              className="rounded-lg border p-3.5 space-y-3"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                borderColor: 'var(--border)',
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">
                      Found {preview.totalParsed} entr{preview.totalParsed === 1 ? 'y' : 'ies'}
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{
                        backgroundColor: 'var(--accent-soft)',
                        color: 'var(--accent)',
                      }}
                    >
                      {preview.detectedFormat}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {selectedFile?.name}
                    {preview.dateRange
                      ? ` · ${formatShortDate(preview.dateRange.from)} – ${formatShortDate(
                          preview.dateRange.to
                        )}`
                      : ''}
                    {preview.duplicateCount > 0
                      ? ` · ${preview.duplicateCount} already in journal`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleCancelImport}
                  className="rounded-md p-1 transition hover:opacity-80"
                  style={{ color: 'var(--text-muted)' }}
                  title="Clear selected file"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {preview.warnings.length > 0 && (
                <div
                  className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"
                  style={{
                    backgroundColor: 'var(--bg-subtle)',
                    borderColor: 'var(--border)',
                    color: 'var(--text-muted)',
                  }}
                >
                  <AlertTriangle
                    className="h-3.5 w-3.5 mt-0.5 shrink-0"
                    style={{ color: 'var(--accent)' }}
                  />
                  <div className="space-y-1">
                    {preview.warnings.map((w, i) => (
                      <div key={i}>{w}</div>
                    ))}
                  </div>
                </div>
              )}

              {/* Sample entries preview */}
              {preview.entries.length > 0 && (
                <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                  {preview.entries.slice(0, 12).map((entry, idx) => (
                    <div
                      key={`${entry.entry_date}-${entry.entry_time}-${idx}`}
                      className="rounded-lg border px-3 py-2 text-xs space-y-1"
                      style={{
                        backgroundColor: 'var(--bg-subtle)',
                        borderColor: 'var(--border)',
                        opacity: skipDuplicates && entry.isDuplicate ? 0.55 : 1,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">
                          {formatShortDate(entry.entry_date)} · {formatTime12h(entry.entry_time)}
                        </span>
                        {entry.isDuplicate && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                            style={{
                              backgroundColor: 'var(--bg-elevated)',
                              color: 'var(--text-muted)',
                            }}
                          >
                            Duplicate
                          </span>
                        )}
                      </div>
                      {entry.title && (
                        <div className="font-medium" style={{ color: 'var(--text)' }}>
                          {entry.title}
                        </div>
                      )}
                      {entry.prompt_text && (
                        <div className="italic" style={{ color: 'var(--accent)' }}>
                          Prompt: {entry.prompt_text}
                        </div>
                      )}
                      {entry.content && (
                        <div
                          className="line-clamp-2 leading-relaxed"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {entry.content}
                        </div>
                      )}
                    </div>
                  ))}
                  {preview.entries.length > 12 && (
                    <div
                      className="text-center text-[11px] py-1"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      + {preview.entries.length - 12} more entr
                      {preview.entries.length - 12 === 1 ? 'y' : 'ies'} ready to import
                    </div>
                  )}
                </div>
              )}

              {/* Import Options */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                <div className="space-y-2">
                  <label
                    className="flex items-center gap-2 text-xs cursor-pointer"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <input
                      type="checkbox"
                      checked={skipDuplicates}
                      onChange={(e) => setSkipDuplicates(e.target.checked)}
                      className="h-3.5 w-3.5 accent-amber-500"
                    />
                    <span>Skip duplicates already in journal</span>
                  </label>
                  <div className="flex items-center gap-2">
                    <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      Optional tag:
                    </label>
                    <input
                      type="text"
                      value={importTag}
                      onChange={(e) => setImportTag(e.target.value)}
                      placeholder="e.g. clearful"
                      className="w-36 rounded-md border px-2 py-1 text-xs focus:outline-none"
                      style={{
                        backgroundColor: 'var(--bg-subtle)',
                        borderColor: 'var(--border)',
                        color: 'var(--text)',
                      }}
                    />
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleCancelImport}
                    disabled={importing}
                    className="rounded-lg border px-3 py-2 text-xs font-medium transition disabled:opacity-40"
                    style={{ borderColor: 'var(--border)' }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleCommitImport}
                    disabled={importing || entriesToImportCount <= 0}
                    className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold text-stone-950 transition hover:opacity-90 disabled:opacity-50"
                    style={{ backgroundColor: 'var(--accent)' }}
                  >
                    {importing ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FileUp className="h-3.5 w-3.5" />
                    )}
                    {importing
                      ? 'Importing…'
                      : `Import ${entriesToImportCount} Entr${
                          entriesToImportCount === 1 ? 'y' : 'ies'
                        }`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {importMsg && (
            <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-500">
              <Check className="h-3.5 w-3.5" />
              {importMsg}
            </div>
          )}
          {importErr && (
            <div className="text-xs font-medium" style={{ color: 'var(--danger)' }}>
              {importErr}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
