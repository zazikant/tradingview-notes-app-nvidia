import { createHash } from 'crypto';

/**
 * SHA-256 hex digest of UTF-8 text.
 * Used as the dedup key for documents synced to the Brain.
 */
export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
