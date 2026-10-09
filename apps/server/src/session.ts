import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { PREVIEW_COOKIE } from './preview.js';
import type { PublicUser } from './vectoree.js';

export const SESSION_COOKIE = 've_session';
const COOKIE = SESSION_COOKIE;

export type SessionRecord = {
  user: PublicUser;
  accessToken: string;
  refreshToken?: string;
  /** Cloud only: the preview this login was made under. */
  previewId?: string;
  /**
   * Server-only password created at registration. The visitor never sees it.
   * Discarded after they set their own password.
   */
  bridgePassword?: string;
};

const sessions = new Map<string, SessionRecord>();

export function createSession(c: Context, record: SessionRecord): void {
  const id = randomBytes(32).toString('hex');
  sessions.set(id, record);
  setCookie(c, COOKIE, id, {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
}

export function updateSession(c: Context, record: SessionRecord): void {
  const id = getCookie(c, COOKIE);
  if (!id || !sessions.has(id)) return;
  sessions.set(id, record);
}

export function readSession(c: Context): SessionRecord | null {
  const id = getCookie(c, COOKIE);
  if (!id) return null;
  const record = sessions.get(id);
  if (!record) return null;
  if (record.previewId !== undefined && record.previewId !== getCookie(c, PREVIEW_COOKIE)) return null;
  return record;
}

export function destroySession(c: Context): void {
  const id = getCookie(c, COOKIE);
  if (id) sessions.delete(id);
  deleteCookie(c, COOKIE, { path: '/' });
}

export function seedSession(record: SessionRecord): string {
  const id = randomBytes(32).toString('hex');
  sessions.set(id, record);
  return id;
}

export function clearSessions(): void {
  sessions.clear();
}
