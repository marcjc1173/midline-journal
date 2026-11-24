import crypto from 'node:crypto';
import fs from 'node:fs';

export const ENCRYPTED_MAGIC = Buffer.from('MDLENC01', 'ascii'); // 8 bytes
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = ENCRYPTED_MAGIC.length + SALT_LEN + IV_LEN; // 36 bytes
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
}

export async function isEncryptedBackupFile(filePath: string): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(ENCRYPTED_MAGIC.length);
    const { bytesRead } = await handle.read(buf, 0, ENCRYPTED_MAGIC.length, 0);
    return bytesRead === ENCRYPTED_MAGIC.length && buf.equals(ENCRYPTED_MAGIC);
  } finally {
    await handle.close();
  }
}

export async function encryptBackupFile(
  inputPath: string,
  outputPath: string,
  passphrase: string
): Promise<void> {
  if (!passphrase || passphrase.length < 4) {
    throw new Error('Backup encryption passphrase must be at least 4 characters.');
  }

  const salt = crypto.randomBytes(SALT_LEN);
  const iv = crypto.randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const output = fs.createWriteStream(outputPath);

  const writeBuf = async (buf: Buffer) => {
    if (!output.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        output.once('drain', resolve);
        output.once('error', reject);
      });
    }
  };

  try {
    await writeBuf(Buffer.concat([ENCRYPTED_MAGIC, salt, iv]));

    const input = fs.createReadStream(inputPath);
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const encrypted = cipher.update(chunk);
      if (encrypted.length > 0) {
        await writeBuf(encrypted);
      }
    }

    const finalChunk = cipher.final();
    if (finalChunk.length > 0) {
      await writeBuf(finalChunk);
    }

    const tag = cipher.getAuthTag();
    await writeBuf(tag);

    await new Promise<void>((resolve, reject) => {
      output.on('error', reject);
      output.on('finish', resolve);
      output.end();
    });
  } catch (err) {
    output.destroy();
    await fs.promises.unlink(outputPath).catch(() => {});
    throw err;
  }
}

export async function decryptBackupFile(
  inputPath: string,
  outputPath: string,
  passphrase: string
): Promise<void> {
  const stat = await fs.promises.stat(inputPath);
  if (stat.size < HEADER_LEN + TAG_LEN) {
    throw new Error('Encrypted backup file is truncated or corrupted.');
  }

  const handle = await fs.promises.open(inputPath, 'r');
  let header: Buffer;
  let tag: Buffer;
  try {
    header = Buffer.alloc(HEADER_LEN);
    await handle.read(header, 0, HEADER_LEN, 0);
    if (!header.subarray(0, ENCRYPTED_MAGIC.length).equals(ENCRYPTED_MAGIC)) {
      throw new Error('File is not a valid Midline encrypted backup.');
    }
    tag = Buffer.alloc(TAG_LEN);
    await handle.read(tag, 0, TAG_LEN, stat.size - TAG_LEN);
  } finally {
    await handle.close();
  }

  const salt = header.subarray(ENCRYPTED_MAGIC.length, ENCRYPTED_MAGIC.length + SALT_LEN);
  const iv = header.subarray(ENCRYPTED_MAGIC.length + SALT_LEN, HEADER_LEN);
  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const output = fs.createWriteStream(outputPath);

  const writeBuf = async (buf: Buffer) => {
    if (!output.write(buf)) {
      await new Promise<void>((resolve, reject) => {
        output.once('drain', resolve);
        output.once('error', reject);
      });
    }
  };

  try {
    const ciphertextEnd = stat.size - TAG_LEN - 1;
    if (ciphertextEnd >= HEADER_LEN) {
      const input = fs.createReadStream(inputPath, {
        start: HEADER_LEN,
        end: ciphertextEnd,
      });
      for await (const rawChunk of input) {
        const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        const decrypted = decipher.update(chunk);
        if (decrypted.length > 0) {
          await writeBuf(decrypted);
        }
      }
    }

    const finalChunk = decipher.final();
    if (finalChunk.length > 0) {
      await writeBuf(finalChunk);
    }

    await new Promise<void>((resolve, reject) => {
      output.on('error', reject);
      output.on('finish', resolve);
      output.end();
    });
  } catch (err) {
    output.destroy();
    await fs.promises.unlink(outputPath).catch(() => {});
    const msg = err instanceof Error ? err.message : '';
    if (msg.includes('Unsupported state') || msg.includes('unable to authenticate')) {
      throw new Error('Incorrect backup passphrase or corrupted encrypted backup.');
    }
    throw err;
  }
}

// Helper for encrypting small secrets (like OAuth tokens / saved passphrase) in SQLite settings
export function encryptSecretString(plaintext: string, masterSecret: string): string {
  const key = crypto.createHash('sha256').update(masterSecret).digest();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecretString(stored: string, masterSecret: string): string {
  if (!stored.startsWith('v1:')) return stored;
  const parts = stored.split(':');
  if (parts.length !== 4) throw new Error('Malformed encrypted setting.');
  const [, ivB64, tagB64, encB64] = parts;
  const key = crypto.createHash('sha256').update(masterSecret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, 'base64')),
    decipher.final(),
  ]);
  return dec.toString('utf8');
}
