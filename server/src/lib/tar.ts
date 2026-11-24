import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Writable } from 'node:stream';

export type TarPackItem =
  | { name: string; content: Buffer }
  | { name: string; filePath: string };

const BLOCK_SIZE = 512;

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const str = Math.max(0, Math.floor(value))
    .toString(8)
    .padStart(length - 1, '0');
  if (str.length > length - 1) {
    throw new Error(`Tar header octal overflow for value ${value}`);
  }
  buf.write(str, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function splitTarPath(entryName: string): { name: string; prefix: string } {
  const normalized = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
  if (Buffer.byteLength(normalized, 'utf8') <= 100) {
    return { name: normalized, prefix: '' };
  }
  const idx = normalized.lastIndexOf('/');
  if (idx !== -1) {
    const prefix = normalized.slice(0, idx);
    const name = normalized.slice(idx + 1);
    if (
      Buffer.byteLength(name, 'utf8') <= 100 &&
      Buffer.byteLength(prefix, 'utf8') <= 155
    ) {
      return { name, prefix };
    }
  }
  throw new Error(`Archive entry path is too long for USTAR header: ${entryName}`);
}

function createTarHeader(entryName: string, size: number, mtimeSec: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE, 0);
  const { name, prefix } = splitTarPath(entryName);

  header.write(name, 0, 100, 'utf8');
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, size); // size
  writeOctal(header, 136, 12, mtimeSec); // mtime
  header.fill(0x20, 148, 156); // checksum placeholder (spaces)
  header[156] = 0x30; // '0' regular file
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  if (prefix) {
    header.write(prefix, 345, 155, 'utf8');
  }

  let checksum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) {
    checksum += header[i];
  }
  const chkStr = checksum.toString(8).padStart(6, '0');
  header.write(chkStr, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

async function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) {
    await new Promise<void>((resolve, reject) => {
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Output stream closed before write completed.'));
      };
      const cleanup = () => {
        stream.off('drain', onDrain);
        stream.off('error', onError);
        stream.off('close', onClose);
      };
      stream.once('drain', onDrain);
      stream.once('error', onError);
      stream.once('close', onClose);
    });
  }
}

export async function packTarGz(items: TarPackItem[], output: Writable): Promise<void> {
  const gzip = zlib.createGzip({ level: 6 });

  const done = new Promise<void>((resolve, reject) => {
    gzip.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    output.on('close', resolve);
  });

  gzip.pipe(output);

  try {
    const nowSec = Math.floor(Date.now() / 1000);
    for (const item of items) {
      if ('content' in item) {
        const header = createTarHeader(item.name, item.content.length, nowSec);
        await writeChunk(gzip, header);
        if (item.content.length > 0) {
          await writeChunk(gzip, item.content);
        }
        const rem = item.content.length % BLOCK_SIZE;
        if (rem !== 0) {
          await writeChunk(gzip, Buffer.alloc(BLOCK_SIZE - rem, 0));
        }
      } else {
        const stat = await fs.promises.stat(item.filePath);
        const header = createTarHeader(
          item.name,
          stat.size,
          Math.floor(stat.mtimeMs / 1000) || nowSec
        );
        await writeChunk(gzip, header);

        let written = 0;
        const rs = fs.createReadStream(item.filePath);
        for await (const chunk of rs) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          written += buf.length;
          await writeChunk(gzip, buf);
        }

        if (written !== stat.size) {
          throw new Error(`File size changed while archiving: ${item.name}`);
        }
        const rem = written % BLOCK_SIZE;
        if (rem !== 0) {
          await writeChunk(gzip, Buffer.alloc(BLOCK_SIZE - rem, 0));
        }
      }
    }

    // End-of-archive marker: two 512-byte zero blocks
    await writeChunk(gzip, Buffer.alloc(BLOCK_SIZE * 2, 0));
    gzip.end();
    await done;
  } catch (err) {
    gzip.destroy();
    throw err;
  }
}

function readCString(buf: Buffer, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const zeroIdx = slice.indexOf(0);
  return slice.subarray(0, zeroIdx === -1 ? slice.length : zeroIdx).toString('utf8');
}

function parseOctal(buf: Buffer, start: number, length: number): number {
  const raw = readCString(buf, start, length).trim();
  if (!raw) return 0;
  const val = parseInt(raw, 8);
  if (Number.isNaN(val) || val < 0) {
    throw new Error(`Invalid tar octal field: "${raw}"`);
  }
  return val;
}

function isZeroBlock(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false;
  }
  return true;
}

export interface ExtractTarGzOptions {
  isAllowedEntry: (normalizedName: string) => boolean;
  maxTotalBytes?: number;
  maxFiles?: number;
}

export interface ExtractTarGzResult {
  extractedFiles: string[];
  totalBytes: number;
}

export async function extractTarGz(
  archivePath: string,
  destDir: string,
  options: ExtractTarGzOptions
): Promise<ExtractTarGzResult> {
  const maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024 * 1024; // 4 GB
  const maxFiles = options.maxFiles ?? 50_000;

  const resolvedDest = path.resolve(destDir);
  await fs.promises.mkdir(resolvedDest, { recursive: true });

  const gunzip = zlib.createGunzip();
  const input = fs.createReadStream(archivePath);
  input.pipe(gunzip);

  const extractedFiles: string[] = [];
  let totalBytes = 0;

  // Stateful streaming tar parser
  let pending = Buffer.alloc(0);
  let state: 'header' | 'body' | 'padding' = 'header';
  let currentRemaining = 0;
  let currentPadding = 0;
  let currentWriteStream: fs.WriteStream | null = null;
  let currentSkip = false;
  let finished = false;

  const closeCurrentStream = async () => {
    if (!currentWriteStream) return;
    const ws = currentWriteStream;
    currentWriteStream = null;
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('finish', resolve);
      ws.end();
    });
  };

  try {
    for await (const rawChunk of gunzip) {
      if (finished) continue;
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

      while (!finished) {
        if (state === 'header') {
          if (pending.length < BLOCK_SIZE) break;
          const header = pending.subarray(0, BLOCK_SIZE);
          pending = pending.subarray(BLOCK_SIZE);

          if (isZeroBlock(header)) {
            finished = true;
            break;
          }

          const namePart = readCString(header, 0, 100);
          const prefixPart = readCString(header, 345, 155);
          const rawName = prefixPart ? `${prefixPart}/${namePart}` : namePart;
          const size = parseOctal(header, 124, 12);
          const typeFlag = String.fromCharCode(header[156] || 0x30);

          // Reject symlinks and hardlinks
          if (typeFlag === '1' || typeFlag === '2') {
            throw new Error('Archive contains unsupported link entries.');
          }

          const rem = size % BLOCK_SIZE;
          currentRemaining = size;
          currentPadding = rem === 0 ? 0 : BLOCK_SIZE - rem;

          // Regular file ('0' or '\0')
          if (typeFlag === '0' || header[156] === 0) {
            const normalized = rawName.replace(/^\.\//, '');
            if (
              !normalized ||
              normalized.startsWith('/') ||
              normalized.includes('\\') ||
              normalized.includes('\0') ||
              normalized.split('/').includes('..')
            ) {
              throw new Error(`Archive contains unsafe path: ${rawName}`);
            }

            if (options.isAllowedEntry(normalized)) {
              if (extractedFiles.length >= maxFiles) {
                throw new Error('Archive contains too many files.');
              }
              totalBytes += size;
              if (totalBytes > maxTotalBytes) {
                throw new Error('Archive exceeds maximum allowed size.');
              }

              const targetPath = path.resolve(resolvedDest, normalized);
              if (
                targetPath !== resolvedDest &&
                !targetPath.startsWith(resolvedDest + path.sep)
              ) {
                throw new Error(`Archive entry escapes destination: ${rawName}`);
              }

              await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
              currentWriteStream = fs.createWriteStream(targetPath);
              currentSkip = false;
              extractedFiles.push(normalized);
            } else {
              currentSkip = true;
            }
          } else {
            // Directory ('5'), PAX header ('x'/'g'), etc. -> skip payload if any
            currentSkip = true;
          }

          if (currentRemaining > 0) {
            state = 'body';
          } else {
            await closeCurrentStream();
            state = currentPadding > 0 ? 'padding' : 'header';
          }
        } else if (state === 'body') {
          if (pending.length === 0) break;
          const take = Math.min(pending.length, currentRemaining);
          const slice = pending.subarray(0, take);
          pending = pending.subarray(take);
          currentRemaining -= take;

          if (!currentSkip && currentWriteStream) {
            await writeChunk(currentWriteStream, slice);
          }

          if (currentRemaining === 0) {
            await closeCurrentStream();
            state = currentPadding > 0 ? 'padding' : 'header';
          }
        } else if (state === 'padding') {
          if (pending.length < currentPadding) break;
          pending = pending.subarray(currentPadding);
          currentPadding = 0;
          state = 'header';
        }
      }
    }

    await closeCurrentStream();
    if (state === 'body' && currentRemaining > 0) {
      throw new Error('Backup archive is truncated or corrupted.');
    }

    return { extractedFiles, totalBytes };
  } catch (err) {
    if (currentWriteStream) {
      currentWriteStream.destroy();
      currentWriteStream = null;
    }
    input.destroy();
    gunzip.destroy();
    throw err;
  }
}
