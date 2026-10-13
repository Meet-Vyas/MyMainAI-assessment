/**
 * Remembers unfinished uploads in localStorage so a refreshed or reopened tab can offer to resume.
 * Browsers don't let a page reopen a file by itself, so the admin re-selects it; these records
 * let us check it's the same file before sending more parts into the old upload.
 */
export interface ResumeRecord {
  videoId: string;
  title: string;
  fileName: string;
  fileSize: number;
  lastModified: number;
  /** SHA-256 of the first and last MiB plus the size; null where WebCrypto is unavailable (plain-HTTP LAN IP). */
  sampleHash: string | null;
  startedAt: string;
}

const KEY = 'ugn.pendingUploads';
const SAMPLE_BYTES = 1024 * 1024;

function readAll(): Record<string, ResumeRecord> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, ResumeRecord>;
  } catch {
    return {};
  }
}

function writeAll(records: Record<string, ResumeRecord>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // Private mode or quota: resume still works by name and size, just without the content check.
  }
}

export const resumeStore = {
  get: (videoId: string): ResumeRecord | undefined => readAll()[videoId],
  list: (): ResumeRecord[] => Object.values(readAll()),
  save(record: ResumeRecord) {
    writeAll({ ...readAll(), [record.videoId]: record });
  },
  remove(videoId: string) {
    const all = readAll();
    delete all[videoId];
    writeAll(all);
  },
};

/** Cheap fingerprint of a file's content: hashing 2 MiB instead of 10 GB takes milliseconds. */
export async function sampleHash(file: Blob): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  const head = await file.slice(0, SAMPLE_BYTES).arrayBuffer();
  const tail = await file.slice(Math.max(0, file.size - SAMPLE_BYTES)).arrayBuffer();
  const size = new TextEncoder().encode(String(file.size));
  const bytes = new Uint8Array(head.byteLength + tail.byteLength + size.byteLength);
  bytes.set(new Uint8Array(head), 0);
  bytes.set(new Uint8Array(tail), head.byteLength);
  bytes.set(size, head.byteLength + tail.byteLength);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type FileMatch = { ok: true } | { ok: false; reason: string };

/**
 * Is `file` the one this upload started with? Size must match exactly (parts are byte ranges).
 * Then the content sample decides when we have one; otherwise fall back to the file name.
 */
export async function matchesUpload(
  file: File,
  expected: { fileName: string; fileSize: number },
  record?: ResumeRecord,
): Promise<FileMatch> {
  if (file.size !== expected.fileSize) {
    return { ok: false, reason: `That file is a different size. Choose "${expected.fileName}".` };
  }
  if (record?.sampleHash) {
    const hash = await sampleHash(file);
    if (hash && hash !== record.sampleHash) {
      return { ok: false, reason: 'That file has different contents from the one this upload started with.' };
    }
    if (hash) return { ok: true };
  }
  if (file.name !== expected.fileName) {
    return { ok: false, reason: `Choose "${expected.fileName}" to resume this upload.` };
  }
  return { ok: true };
}

/** Finds an unfinished upload that this file looks like, so picking it again offers a resume. */
export function findRecordForFile(file: File): ResumeRecord | undefined {
  return resumeStore
    .list()
    .find((r) => r.fileName === file.name && r.fileSize === file.size && r.lastModified === file.lastModified);
}
