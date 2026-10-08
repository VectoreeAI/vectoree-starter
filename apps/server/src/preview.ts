import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export const PREVIEW_COOKIE = 've_preview';
export const PREVIEW_IDLE_MS = 12 * 60 * 60 * 1000;

export type PreviewRecord = {
  apiUrl: string;
  apiKey: string;
  projectId: string;
  organizationId?: string;
};

type Stored = PreviewRecord & { lastUsed: number };

const previews = new Map<string, Stored>();

const sweep = setInterval(() => sweepPreviews(Date.now()), 60 * 60 * 1000);
sweep.unref();

export function createPreview(c: Context, record: PreviewRecord, now = Date.now()): string {
  const previous = getCookie(c, PREVIEW_COOKIE);
  if (previous) previews.delete(previous);
  const id = randomBytes(32).toString('hex');
  previews.set(id, { ...record, lastUsed: now });
  setCookie(c, PREVIEW_COOKIE, id, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
  return id;
}

export function readPreview(c: Context, now = Date.now()): (PreviewRecord & { id: string }) | null {
  const id = getCookie(c, PREVIEW_COOKIE);
  if (!id) return null;
  const stored = previews.get(id);
  if (!stored) return null;
  if (now - stored.lastUsed > PREVIEW_IDLE_MS) {
    previews.delete(id);
    return null;
  }
  stored.lastUsed = now;
  const { lastUsed: _lastUsed, ...record } = stored;
  return { ...record, id };
}

export function sweepPreviews(now: number): void {
  for (const [id, stored] of previews) {
    if (now - stored.lastUsed > PREVIEW_IDLE_MS) previews.delete(id);
  }
}

export function seedPreview(record: PreviewRecord, now = Date.now()): string {
  const id = randomBytes(32).toString('hex');
  previews.set(id, { ...record, lastUsed: now });
  return id;
}

export function clearPreviews(): void {
  previews.clear();
}
