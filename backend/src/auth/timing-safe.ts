import { createHash, timingSafeEqual } from 'crypto';

/** Constant-time comparison; hashing first equalizes lengths for timingSafeEqual. */
export function safeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}
