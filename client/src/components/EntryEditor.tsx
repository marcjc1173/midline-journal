import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  Camera,
  Clock,
  ImagePlus,
  Loader2,
  Quote,
  Tag,
  X,
  Check,
  Battery,
} from 'lucide-react';
import { api } from '../api';
import {
  getNowHm,
  getTodayYmd,
  MAX_PHOTO_SIZE_MB,
  MAX_PHOTOS_PER_ENTRY,
  MOODS,
  type Entry,
  type Photo,
  type Prompt,
} from '../types';

export const NEW_DRAFT_KEY = 'midline-draft-new';

export interface SavedDraft {
  title: string;
  content: string;
  entryDate: string;
  entryTime: string;
  mood: string | null;
  energy: number | null;
  promptId: number | null;
  promptText: string | null;
  tags: string[];
  updatedAt: number;
}

export function loadSavedDraft(key: string): SavedDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedDraft;
    if (!parsed.title?.trim() && !parsed.content?.trim()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSavedDraft(key: string): void {
  localStorage.removeItem(key);
}

interface EntryEditorProps {
  initialEntry?: Entry | null;
  initialDate?: string;
  initialPrompt?: Prompt | null;
  onSaved: (entry: Entry) => void;
  onCancel: () => void;
}

interface PendingFile {
  file: File;
  previewUrl: string;
}

export function EntryEditor({
  initialEntry,
  initialDate,
  initialPrompt,
  onSaved,
  onCancel,
}: EntryEditorProps) {
  const isEditing = Boolean(initialEntry);
  const draftKey = initialEntry ? `midline-draft-${initialEntry.id}` : NEW_DRAFT_KEY;
  const restoredDraft = useRef<SavedDraft | null>(
    initialPrompt ? null : loadSavedDraft(draftKey)
  );

  const [title, setTitle] = useState(
    restoredDraft.current?.title ?? initialEntry?.title ?? ''
  );
  const [content, setContent] = useState(
    restoredDraft.current?.content ?? initialEntry?.content ?? ''
  );
  const [entryDate, setEntryDate] = useState(
    restoredDraft.current?.entryDate ??
      initialEntry?.entry_date ??
      initialDate ??
      getTodayYmd()
  );
  const [entryTime, setEntryTime] = useState(
    restoredDraft.current?.entryTime ?? initialEntry?.entry_time ?? getNowHm()
  );
  const [mood, setMood] = useState<string | null>(
    restoredDraft.current ? restoredDraft.current.mood : initialEntry?.mood ?? null
  );
  const [energy, setEnergy] = useState<number | null>(
    restoredDraft.current ? restoredDraft.current.energy : initialEntry?.energy ?? null
  );
  const [promptId, setPromptId] = useState<number | null>(
    restoredDraft.current
      ? restoredDraft.current.promptId
      : initialEntry?.prompt_id ?? initialPrompt?.id ?? null
  );
  const [promptText, setPromptText] = useState<string | null>(
    restoredDraft.current
      ? restoredDraft.current.promptText
      : initialEntry?.prompt_text ?? initialPrompt?.question ?? null
  );
  const [tags, setTags] = useState<string[]>(
    restoredDraft.current?.tags ?? initialEntry?.tags ?? []
  );
  const [draftStatus, setDraftStatus] = useState<'idle' | 'restored' | 'saved'>(
    restoredDraft.current ? 'restored' : 'idle'
  );
  const [tagInput, setTagInput] = useState('');
  const [existingPhotos, setExistingPhotos] = useState<Photo[]>(
    initialEntry?.photos || []
  );
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [photoNotice, setPhotoNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const totalPhotos = existingPhotos.length + pendingFiles.length;
  const atPhotoLimit = totalPhotos >= MAX_PHOTOS_PER_ENTRY;
  const activePhotoAlert =
    photoNotice ||
    (atPhotoLimit
      ? `Photo limit reached (${MAX_PHOTOS_PER_ENTRY}/${MAX_PHOTOS_PER_ENTRY}). You can attach up to ${MAX_PHOTOS_PER_ENTRY} photos per entry.`
      : '');

  // Auto-save draft to localStorage so Auto-Lock or accidental refresh never loses writing
  useEffect(() => {
    const hasText = Boolean(title.trim() || content.trim());
    const timer = window.setTimeout(() => {
      if (!hasText) {
        clearSavedDraft(draftKey);
        return;
      }
      const draft: SavedDraft = {
        title,
        content,
        entryDate,
        entryTime,
        mood,
        energy,
        promptId,
        promptText,
        tags,
        updatedAt: Date.now(),
      };
      try {
        localStorage.setItem(draftKey, JSON.stringify(draft));
        setDraftStatus('saved');
      } catch {
        // ignore storage quota errors
      }
    }, 450);

    return () => window.clearTimeout(timer);
  }, [
    draftKey,
    title,
    content,
    entryDate,
    entryTime,
    mood,
    energy,
    promptId,
    promptText,
    tags,
  ]);

  const handleDiscardAndCancel = () => {
    clearSavedDraft(draftKey);
    onCancel();
  };

  const addTag = (raw: string) => {
    const cleaned = raw.trim().toLowerCase().replace(/^#/, '');
    if (!cleaned || tags.includes(cleaned)) return;
    setTags([...tags, cleaned]);
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(tagInput);
      setTagInput('');
    } else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
      setTags(tags.slice(0, -1));
    }
  };

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList) return;
    const imageFiles = Array.from(fileList).filter((file) =>
      file.type.startsWith('image/')
    );
    if (imageFiles.length === 0) return;

    const currentTotal = existingPhotos.length + pendingFiles.length;
    const remaining = Math.max(0, MAX_PHOTOS_PER_ENTRY - currentTotal);

    if (remaining === 0) {
      setPhotoNotice(
        `Photo limit reached (${MAX_PHOTOS_PER_ENTRY}/${MAX_PHOTOS_PER_ENTRY}). Remove a photo to add another.`
      );
      return;
    }

    const accepted = imageFiles.slice(0, remaining);
    const skipped = imageFiles.length - accepted.length;
    const added: PendingFile[] = accepted.map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
    }));

    setPendingFiles((prev) => [...prev, ...added]);

    const newTotal = currentTotal + added.length;
    if (skipped > 0) {
      setPhotoNotice(
        `Photo limit reached (${MAX_PHOTOS_PER_ENTRY}/${MAX_PHOTOS_PER_ENTRY}). Entries can have up to ${MAX_PHOTOS_PER_ENTRY} photos — ${skipped} extra photo${
          skipped === 1 ? '' : 's'
        } ${skipped === 1 ? 'was' : 'were'} not added.`
      );
    } else if (newTotal >= MAX_PHOTOS_PER_ENTRY) {
      setPhotoNotice(
        `Photo limit reached (${MAX_PHOTOS_PER_ENTRY}/${MAX_PHOTOS_PER_ENTRY}). You can attach up to ${MAX_PHOTOS_PER_ENTRY} photos per entry.`
      );
    } else {
      setPhotoNotice('');
    }
  };

  const removePendingFile = (idx: number) => {
    setPendingFiles((prev) => {
      const target = prev[idx];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
    setPhotoNotice('');
  };

  const deleteExistingPhoto = async (photoId: string) => {
    try {
      await api.deletePhoto(photoId);
      setExistingPhotos((prev) => prev.filter((p) => p.id !== photoId));
      setPhotoNotice('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove photo');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !content.trim() &&
      !title.trim() &&
      existingPhotos.length === 0 &&
      pendingFiles.length === 0
    ) {
      setError('Write a few words or attach a photo before saving.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const finalTags = tagInput.trim()
        ? [...new Set([...tags, tagInput.trim().toLowerCase().replace(/^#/, '')])]
        : tags;

      const payload = {
        title,
        content,
        entry_date: entryDate,
        entry_time: entryTime,
        mood,
        energy,
        prompt_id: promptId,
        prompt_text: promptText,
        tags: finalTags,
      };

      let savedEntry: Entry;
      if (isEditing && initialEntry) {
        const res = await api.updateEntry(initialEntry.id, payload);
        savedEntry = res.entry;
      } else {
        const res = await api.createEntry(payload);
        savedEntry = res.entry;
      }

      if (pendingFiles.length > 0) {
        const up = await api.uploadPhotos(
          savedEntry.id,
          pendingFiles.map((p) => p.file)
        );
        savedEntry = {
          ...savedEntry,
          photos: [...savedEntry.photos, ...up.photos],
        };
        pendingFiles.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      }

      clearSavedDraft(draftKey);
      onSaved(savedEntry);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save entry.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border p-5 sm:p-6 shadow-sm"
      style={{
        backgroundColor: 'var(--bg-elevated)',
        borderColor: 'var(--border)',
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handleFilesSelected(e.dataTransfer.files);
      }}
    >
      {/* Header row: Date + Time + Close */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <label
            className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          >
            <Calendar className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
            <input
              type="date"
              value={entryDate}
              onChange={(e) => setEntryDate(e.target.value)}
              className="bg-transparent text-xs focus:outline-none"
            />
          </label>
          <label
            className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs"
            style={{
              backgroundColor: 'var(--bg-subtle)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          >
            <Clock className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
            <input
              type="time"
              value={entryTime}
              onChange={(e) => setEntryTime(e.target.value)}
              className="bg-transparent text-xs focus:outline-none"
            />
          </label>
        </div>

        <div className="flex items-center gap-2">
          {draftStatus !== 'idle' && (
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {draftStatus === 'restored' ? 'Draft restored' : 'Draft saved'}
            </span>
          )}
          <button
            type="button"
            onClick={handleDiscardAndCancel}
            className="rounded-lg p-1.5 transition hover:opacity-80"
            style={{ color: 'var(--text-muted)' }}
            aria-label="Cancel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Prompt banner if answering a question */}
      {promptText && (
        <div
          className="mb-4 flex items-start justify-between gap-3 rounded-lg border-l-2 px-3.5 py-2.5 text-sm italic"
          style={{
            backgroundColor: 'var(--accent-soft)',
            borderLeftColor: 'var(--accent)',
          }}
        >
          <div className="flex items-start gap-2">
            <Quote className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--accent)' }} />
            <span>{promptText}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setPromptId(null);
              setPromptText(null);
            }}
            className="shrink-0 opacity-60 hover:opacity-100"
            title="Clear prompt"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Optional title */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Headline (optional)"
        className="mb-3 w-full bg-transparent text-lg font-semibold placeholder:opacity-40 focus:outline-none"
      />

      {/* Main writing surface */}
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="What's on your mind today? Write freely—no one else is reading this."
        rows={7}
        autoFocus
        className="font-journal w-full resize-y bg-transparent text-[16px] leading-relaxed placeholder:opacity-40 focus:outline-none"
      />

      {/* Mood & Energy quick check-in */}
      <div
        className="mt-4 space-y-3 border-t pt-4"
        style={{ borderColor: 'var(--border)' }}
      >
        <div>
          <div
            className="mb-2 text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            How are you feeling?
          </div>
          <div className="flex flex-wrap gap-1.5">
            {MOODS.map((m) => {
              const selected = mood === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMood(selected ? null : m.id)}
                  className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition"
                  style={{
                    borderColor: selected ? m.color : 'var(--border)',
                    backgroundColor: selected ? `${m.color}24` : 'transparent',
                    color: selected ? m.color : 'var(--text-muted)',
                  }}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: m.color }}
                  />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Energy 1-5 */}
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            <Battery className="h-3.5 w-3.5" />
            Energy
          </span>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((lvl) => {
              const active = energy === lvl;
              return (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setEnergy(active ? null : lvl)}
                  className="h-7 w-7 rounded-md border text-xs font-medium transition"
                  style={{
                    borderColor: active ? 'var(--accent)' : 'var(--border)',
                    backgroundColor: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text-muted)',
                  }}
                >
                  {lvl}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Tag className="h-3.5 w-3.5" style={{ color: 'var(--text-muted)' }} />
          {tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs"
              style={{
                backgroundColor: 'var(--bg-subtle)',
                color: 'var(--text)',
              }}
            >
              #{t}
              <button
                type="button"
                onClick={() => setTags(tags.filter((x) => x !== t))}
                className="opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={handleTagKeyDown}
            placeholder="Add tag + Enter (e.g. family, work, health)"
            className="min-w-[180px] flex-1 bg-transparent text-xs placeholder:opacity-50 focus:outline-none"
          />
        </div>

        {/* Photos */}
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              handleFilesSelected(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />

          {(existingPhotos.length > 0 || pendingFiles.length > 0) && (
            <div className="mb-3 grid grid-cols-3 sm:grid-cols-4 gap-2">
              {existingPhotos.map((p) => (
                <div
                  key={p.id}
                  className="relative overflow-hidden rounded-lg border"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <img
                    src={p.thumbUrl}
                    alt={p.original_name}
                    className="aspect-square w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => deleteExistingPhoto(p.id)}
                    className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white hover:bg-black"
                    title="Remove photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {pendingFiles.map((pf, idx) => (
                <div
                  key={pf.previewUrl}
                  className="relative overflow-hidden rounded-lg border"
                  style={{ borderColor: 'var(--accent)' }}
                >
                  <img
                    src={pf.previewUrl}
                    alt={pf.file.name}
                    className="aspect-square w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removePendingFile(idx)}
                    className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white hover:bg-black"
                    title="Remove photo"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={atPhotoLimit}
              onClick={() => cameraInputRef.current?.click()}
              title={
                atPhotoLimit
                  ? `Maximum of ${MAX_PHOTOS_PER_ENTRY} photos per entry reached`
                  : undefined
              }
              className="inline-flex items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                borderColor: 'var(--border)',
                backgroundColor: 'var(--bg-subtle)',
                color: 'var(--text)',
              }}
            >
              <Camera className="h-4 w-4" style={{ color: 'var(--accent)' }} />
              Take Photo
            </button>

            <button
              type="button"
              disabled={atPhotoLimit}
              onClick={() => fileInputRef.current?.click()}
              title={
                atPhotoLimit
                  ? `Maximum of ${MAX_PHOTOS_PER_ENTRY} photos per entry reached`
                  : undefined
              }
              className={`inline-flex items-center gap-2 rounded-lg border border-dashed px-3.5 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                isDragging && !atPhotoLimit ? 'scale-[1.01]' : ''
              }`}
              style={{
                borderColor: isDragging && !atPhotoLimit ? 'var(--accent)' : 'var(--border)',
                color: 'var(--text-muted)',
                backgroundColor:
                  isDragging && !atPhotoLimit ? 'var(--accent-soft)' : 'transparent',
              }}
            >
              <ImagePlus className="h-4 w-4" style={{ color: 'var(--accent)' }} />
              Choose Photos
            </button>

            <span
              className="text-xs"
              style={{ color: atPhotoLimit ? 'var(--accent)' : 'var(--text-muted)' }}
            >
              {totalPhotos}/{MAX_PHOTOS_PER_ENTRY} photos (max {MAX_PHOTO_SIZE_MB} MB each)
            </span>
          </div>

          {activePhotoAlert && (
            <div
              role="alert"
              className="mt-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs font-medium"
              style={{
                backgroundColor: 'var(--accent-soft)',
                borderColor: 'var(--accent)',
                color: 'var(--accent)',
              }}
            >
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{activePhotoAlert}</span>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="mt-3 text-xs font-medium" style={{ color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="mt-5 flex items-center justify-end gap-2.5">
        <button
          type="button"
          onClick={handleDiscardAndCancel}
          className="rounded-lg border px-4 py-2 text-sm font-medium transition hover:opacity-80"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold text-stone-950 transition disabled:opacity-50"
          style={{ backgroundColor: 'var(--accent)' }}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          {isEditing ? 'Save Changes' : 'Save Entry'}
        </button>
      </div>
    </form>
  );
}
