import crypto from 'node:crypto';

const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MIN_SECRET_LENGTH = 16;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function deriveKey(secret: string, salt: Buffer) {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`Vault secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return crypto.scryptSync(secret, salt, 32, SCRYPT);
}

export function seal(plaintext: string, secret: string) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function open(payload: string, secret: string) {
  const data = Buffer.from(payload, 'base64');
  const header = 1 + SALT_BYTES + IV_BYTES + TAG_BYTES;
  if (data.length < header || data[0] !== VERSION) throw new Error('Unsupported vault payload');
  const salt = data.subarray(1, 1 + SALT_BYTES);
  const iv = data.subarray(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const tag = data.subarray(1 + SALT_BYTES + IV_BYTES, header);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret, salt), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data.subarray(header)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Vault decryption failed: wrong secret or corrupted data');
  }
}
