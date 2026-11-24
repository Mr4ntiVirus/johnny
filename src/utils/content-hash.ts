import { createHash } from 'node:crypto';

/** Whitespace-normalised text so trivially reflowed copies hash identically. */
export function normalizeForHash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stable content hash for chunk/window dedup (sha256 of whitespace-normalised text). */
export function contentHash(text: string): string {
  return sha256(normalizeForHash(text));
}

/** Hash of an ordered list of hashes (e.g. the chunks that make up an extraction window). */
export function combineHashes(hashes: string[]): string {
  return sha256(hashes.join('|'));
}
