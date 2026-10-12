import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { ConfigError, type AppConfig } from './config.js';
import { resolveScope } from './scope.js';
import { readSession } from './session.js';
import { objectKey, objectPath, putObject, storageFetch } from './storage.js';
import { FALLBACK_MODEL, readErrorMessage } from './vectoree.js';

/** One row per message. Every chat for the connected project lives in this table. */
const CHAT_TABLE = 'starter_chat_messages';
/** Chat images are uploaded here; rows keep the object URL instead of the bytes. */
const IMAGE_BUCKET = 'starter_chat_images';
const IMAGE_ROUTE = '/api/chat-images';

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 16_000;
const MAX_IMAGE_CHARS = 120_000;
const MAX_GENERATED_DATA_URL = 800_000;
const MAX_HTTP_URL = 8_000;
const MAX_BODY = 1_500_000;
const MAX_ROWS = MAX_CONVERSATIONS * MAX_MESSAGES;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATA_URL = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;
const STORED_OBJECT = new RegExp(`/api/storage/buckets/${IMAGE_BUCKET}/objects/([^?#]+)`);

export const DEFAULT_TITLE = 'New chat';

export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  titledByModel?: boolean;
};

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: { mediaType?: string; data?: string; url?: string };
  generated?: { url: string }[];
};

export type Conversation = ConversationMeta & { messages: StoredMessage[] };

type Deps = {
  root: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
};

type Owner = {
  fetchImpl: typeof fetch;
  apiUrl: string;
  apiKey: string;
  projectId: string;
  userId: string;
};

type MessageRow = {
  id?: unknown;
  chat_id?: unknown;
  user_id?: unknown;
  chat_title?: unknown;
  titled_by_model?: unknown;
  seq?: unknown;
  role?: unknown;
  content?: unknown;
  image_urls?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

const ensured = new Map<string, Promise<void>>();

const locks = new Map<string, Promise<void>>();

/** Chats without messages yet. They only reach the table with their first message. */
const drafts = new Map<string, Map<string, ConversationMeta>>();

export function clearConversationDrafts(): void {
  drafts.clear();
}

export function mountConversations(app: Hono, deps: Deps): void {
  app.get('/api/conversations', (c) =>
    withUser(c, deps, async (owner) => c.json({ conversations: await readIndex(owner) })),
  );

  app.post('/api/conversations', async (c) =>
    withUser(c, deps, async (owner) => {
      const body = await readJson(c);
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const title = typeof record.title === 'string' && record.title.trim() ? sanitizeTitle(record.title) : DEFAULT_TITLE;
      const created = await withLock(lockKey(owner), async () => {
        const pending = ownerDrafts(owner);
        if (record.force !== true) {
          const reusable = [...pending.values()].find((item) => item.title === DEFAULT_TITLE && !item.titledByModel);
          if (reusable) return reusable;
        }
        const index = await readIndex(owner);
        if (index.length >= MAX_CONVERSATIONS) throw new ConfigError('Too many conversations');
        const now = new Date().toISOString();
        const meta: ConversationMeta = { id: randomUUID(), title, createdAt: now, updatedAt: now };
        pending.set(meta.id, meta);
        return meta;
      });
      return c.json(created, 201);
    }),
  );

  app.get('/api/conversations/:id', (c) =>
    withUser(c, deps, async (owner) => {
      const conversation = await readConversation(owner, conversationId(c.req.param('id')));
      if (!conversation) return c.json({ message: 'Conversation not found' }, 404);
      return c.json(conversation);
    }),
  );

  app.put('/api/conversations/:id', async (c) =>
    withUser(c, deps, async (owner) => {
      const id = conversationId(c.req.param('id'));
      const raw = await c.req.text();
      if (raw.length > MAX_BODY) return c.json({ message: 'Request is too large' }, 413);
      const messages = parseMessages(parseJson(raw));
      const saved = await withLock(lockKey(owner), async () => saveMessages(owner, id, messages));
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json(saved);
    }),
  );

  app.patch('/api/conversations/:id', async (c) =>
    withUser(c, deps, async (owner) => {
      const id = conversationId(c.req.param('id'));
      const body = await readJson(c);
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      if (typeof record.title !== 'string' || !record.title.trim()) throw new ConfigError('title is required');
      const title = sanitizeTitle(record.title);
      const saved = await withLock(lockKey(owner), async () => renameChat(owner, id, title));
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json(saved);
    }),
  );

  app.delete('/api/conversations/:id', (c) =>
    withUser(c, deps, async (owner) => {
      const id = conversationId(c.req.param('id'));
      const removed = await withLock(lockKey(owner), async () => deleteChat(owner, id));
      if (!removed) return c.json({ message: 'Conversation not found' }, 404);
      return c.json({ ok: true });
    }),
  );

  app.post('/api/conversations/:id/generate-title', async (c) =>
    withUser(c, deps, async (owner, config) => {
      const id = conversationId(c.req.param('id'));
      const body = await readJson(c);
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : FALLBACK_MODEL;
      const current = await readConversation(owner, id);
      if (!current) return c.json({ message: 'Conversation not found' }, 404);
      const snippet = transcriptSnippet(current.messages);
      if (!snippet) throw new ConfigError('A user message is required before naming this chat');
      const title = sanitizeTitle(await requestTitle(deps.fetchImpl, config, model, snippet));
      const saved = await withLock(lockKey(owner), async () => renameChat(owner, id, title));
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json({ id: saved.id, title: saved.title });
    }),
  );

  app.get(IMAGE_ROUTE, (c) =>
    withUser(c, deps, async (owner) => {
      const key = objectKey(c.req.query('key') ?? '');
      if (!key.startsWith(`${userFolder(owner)}/`)) return c.json({ message: 'Image not found' }, 404);
      const upstream = await storageFetch(owner.fetchImpl, owner, objectPath(IMAGE_BUCKET, key), { method: 'GET' }, false);
      if (!upstream.ok) return c.json({ message: 'Image not found' }, 404);
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
          'Cache-Control': 'private, max-age=86400',
        },
      });
    }),
  );
}

export function sanitizeTitle(raw: string): string {
  const title = raw
    .trim()
    .replace(/^["'`「」]+|["'`「」]+$/g, '')
    .replace(/[*#_`]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。!！?？,，;；:：]+$/g, '')
    .trim()
    .slice(0, 60)
    .trim();
  if (!title) throw new ConfigError('Could not name this chat');
  return title;
}

async function requestTitle(
  fetchImpl: typeof fetch,
  config: AppConfig & { apiKey: string },
  model: string,
  snippet: string,
): Promise<string> {
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${config.apiUrl}/api/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: 'system',
            content:
              'You name chat threads. Reply with only a short title (≤ 8 words / ≤ 24 Chinese characters). No quotes, no punctuation spam, no markdown.',
          },
          { role: 'user', content: snippet },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${config.apiUrl} (${redact(reason, config.apiKey)})`, 502);
  }
  const data = await readJsonSafe(upstream);
  if (!upstream.ok) {
    throw new ConfigError(redact(readErrorMessage(data, `Could not name this chat (${upstream.status})`), config.apiKey), 502);
  }
  const content = readCompletion(data);
  if (!content) throw new ConfigError('Could not name this chat', 502);
  return content;
}

function transcriptSnippet(messages: StoredMessage[]): string {
  const user = messages.find((item) => item.role === 'user' && item.content.trim());
  if (!user) return '';
  const assistant = messages.find((item) => item.role === 'assistant' && item.content.trim());
  const lines = [`User: ${user.content.trim().slice(0, 800)}`];
  if (assistant) lines.push(`Assistant: ${assistant.content.trim().slice(0, 800)}`);
  return lines.join('\n');
}

function readCompletion(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return '';
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : '';
}

async function withUser(
  c: Context,
  deps: Deps,
  run: (owner: Owner, config: AppConfig & { apiKey: string }) => Promise<Response>,
): Promise<Response> {
  const config = resolveScope(c, deps.root, deps.env);
  const session = readSession(c);
  if (!session) return c.json({ message: 'Sign in required' }, 401);
  if (!config.projectId || !config.apiKey) throw new ConfigError('Link a Vectoree project first');
  const owner: Owner = {
    fetchImpl: deps.fetchImpl,
    apiUrl: config.apiUrl,
    apiKey: config.apiKey,
    projectId: config.projectId,
    userId: session.user.id,
  };
  await ensureOnce(`table\n${owner.apiUrl}\n${owner.projectId}`, () => createChatTable(owner));
  return run(owner, config);
}

function conversationId(value: string): string {
  if (!UUID.test(value)) throw new ConfigError('Invalid conversation id');
  return value;
}

function parseMessages(body: unknown): StoredMessage[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConfigError('Expected a JSON object');
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) throw new ConfigError('messages is required');
  if (messages.length > MAX_MESSAGES) throw new ConfigError('Too many messages');
  const seen = new Set<string>();
  return messages.map((item) => {
    if (!item || typeof item !== 'object') throw new ConfigError('Invalid message');
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim().toLowerCase() : '';
    if (!UUID.test(id) || seen.has(id)) throw new ConfigError('Invalid message id');
    seen.add(id);
    if (record.role !== 'user' && record.role !== 'assistant') throw new ConfigError('Invalid message role');
    const content = typeof record.content === 'string' ? record.content.slice(0, MAX_CONTENT) : '';
    const image = parseImage(record.image);
    const generated = parseGenerated(record.generated);
    if (!content.trim() && !image && !generated?.length && record.role === 'user') {
      throw new ConfigError('Message is empty');
    }
    return {
      id,
      role: record.role,
      content,
      ...(image ? { image } : {}),
      ...(generated?.length ? { generated } : {}),
    };
  });
}

function parseImage(value: unknown): StoredMessage['image'] {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const url = typeof record.url === 'string' ? keepStoredUrl(record.url) : '';
  if (url) return { url };
  const mediaType = typeof record.mediaType === 'string' ? record.mediaType.slice(0, 80) : '';
  if (!mediaType.startsWith('image/')) return undefined;
  const data = typeof record.data === 'string' ? record.data : '';
  if (!data || data.length > MAX_IMAGE_CHARS) return { mediaType };
  return { mediaType, data };
}

function parseGenerated(value: unknown): { url: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const urls = value
    .slice(0, 8)
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const url = (item as { url?: unknown }).url;
      return typeof url === 'string' ? keepGeneratedUrl(url) : '';
    })
    .filter(Boolean)
    .map((url) => ({ url }));
  return urls;
}

function keepGeneratedUrl(url: string): string {
  if (url.startsWith('data:image/')) return url.length <= MAX_GENERATED_DATA_URL ? url : '';
  if (url.startsWith('https://') || url.startsWith('http://')) return url.length <= MAX_HTTP_URL ? url : '';
  return keepStoredUrl(url);
}

function keepStoredUrl(url: string): string {
  return url.startsWith(`${IMAGE_ROUTE}?key=`) && url.length <= MAX_HTTP_URL ? url : '';
}

function lockKey(owner: Owner): string {
  return `${owner.projectId}:${owner.userId}`;
}

function ownerDrafts(owner: Owner): Map<string, ConversationMeta> {
  const key = lockKey(owner);
  let found = drafts.get(key);
  if (!found) {
    found = new Map();
    drafts.set(key, found);
  }
  return found;
}

async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

async function ensureOnce(key: string, create: () => Promise<void>): Promise<void> {
  let pending = ensured.get(key);
  if (!pending) {
    pending = create().catch((error: unknown) => {
      ensured.delete(key);
      throw error;
    });
    ensured.set(key, pending);
  }
  await pending;
}

async function createChatTable(owner: Owner): Promise<void> {
  const listed = await db(owner, `/api/database/tables`);
  const names = Array.isArray(listed.data) ? listed.data.filter((item): item is string => typeof item === 'string') : [];
  if (!listed.ok) throw dbError(owner, listed.data, 'Could not list tables');
  if (names.includes(CHAT_TABLE)) return;
  const column = (columnName: string, type: string, isNullable = false) => ({ columnName, type, isNullable, isUnique: false });
  const created = await db(owner, '/api/database/tables', {
    method: 'POST',
    body: JSON.stringify({
      tableName: CHAT_TABLE,
      rlsEnabled: false,
      columns: [
        column('chat_id', 'uuid'),
        column('user_id', 'string'),
        column('chat_title', 'string'),
        column('titled_by_model', 'boolean'),
        column('seq', 'integer'),
        column('role', 'string'),
        column('content', 'string'),
        column('image_urls', 'string', true),
      ],
    }),
  });
  if (created.ok) return;
  const message = readErrorMessage(created.data, `Could not create ${CHAT_TABLE}`);
  if (created.status === 400 && /already exists/i.test(message)) return;
  throw dbError(owner, created.data, `Could not create ${CHAT_TABLE}`);
}

async function createImageBucket(owner: Owner): Promise<void> {
  const created = await storageFetch(
    owner.fetchImpl,
    owner,
    '/api/storage/buckets',
    { method: 'POST', body: JSON.stringify({ bucketName: IMAGE_BUCKET, isPublic: false }) },
    true,
  );
  if (created.ok) return;
  const data = await readJsonSafe(created);
  const message = readErrorMessage(data, `Could not create ${IMAGE_BUCKET}`);
  if ((created.status === 400 || created.status === 409) && /already exists/i.test(message)) return;
  throw new ConfigError(redact(message, owner.apiKey), 502);
}

async function readIndex(owner: Owner): Promise<ConversationMeta[]> {
  const params = new URLSearchParams({
    user_id: `eq.${owner.userId}`,
    order: 'updated_at.desc',
    limit: String(MAX_ROWS),
    select: 'chat_id,chat_title,titled_by_model,created_at,updated_at',
  });
  const result = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`);
  if (!result.ok) throw dbError(owner, result.data, 'Could not list chats');
  const chats = groupChats(rows(result.data));
  const pending = ownerDrafts(owner);
  for (const id of chats.keys()) pending.delete(id);
  return [...chats.values(), ...pending.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function readChatRows(owner: Owner, id: string): Promise<MessageRow[]> {
  const params = new URLSearchParams({
    chat_id: `eq.${id}`,
    user_id: `eq.${owner.userId}`,
    order: 'seq.asc',
    limit: String(MAX_MESSAGES * 2),
  });
  const result = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`);
  if (!result.ok) throw dbError(owner, result.data, 'Could not load the chat');
  return rows(result.data);
}

async function readConversation(owner: Owner, id: string): Promise<Conversation | null> {
  const found = await readChatRows(owner, id);
  const meta = groupChats(found).get(id);
  if (!meta) {
    const draft = ownerDrafts(owner).get(id);
    return draft ? { ...draft, messages: [] } : null;
  }
  return { ...meta, messages: found.flatMap((row) => rowMessage(row)) };
}

async function readMeta(owner: Owner, id: string): Promise<ConversationMeta | null> {
  return groupChats(await readChatRows(owner, id)).get(id) ?? ownerDrafts(owner).get(id) ?? null;
}

async function saveMessages(owner: Owner, id: string, messages: StoredMessage[]): Promise<Conversation | null> {
  const existing = await readChatRows(owner, id);
  const pending = ownerDrafts(owner);
  const meta = groupChats(existing).get(id) ?? pending.get(id);
  if (!meta) return null;
  const byId = new Map(existing.flatMap((row) => (typeof row.id === 'string' ? [[row.id, row] as const] : [])));
  const inserts: Record<string, unknown>[] = [];
  const saved: StoredMessage[] = [];
  for (const [seq, message] of messages.entries()) {
    const current = byId.get(message.id);
    const savedUrls = splitUrls(current?.image_urls);
    const urls = savedUrls.length ? savedUrls : await storeImages(owner, id, message);
    const fields = {
      seq,
      role: message.role,
      content: message.content,
      image_urls: urls.length ? urls.join('\n') : null,
    };
    saved.push(...rowMessage({ id: message.id, ...fields }));
    if (!current) {
      inserts.push({
        id: message.id,
        chat_id: id,
        user_id: owner.userId,
        chat_title: meta.title,
        titled_by_model: Boolean(meta.titledByModel),
        ...fields,
      });
      continue;
    }
    const sameText = current.seq === seq && current.role === fields.role && current.content === fields.content;
    if (sameText && (savedUrls.length || !urls.length)) continue;
    const params = new URLSearchParams({ id: `eq.${message.id}`, user_id: `eq.${owner.userId}` });
    const updated = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
    if (!updated.ok) throw dbError(owner, updated.data, 'Could not save the chat');
  }
  if (inserts.length) {
    const created = await db(owner, `/api/database/records/${CHAT_TABLE}`, {
      method: 'POST',
      body: JSON.stringify(inserts),
    });
    if (!created.ok) throw dbError(owner, created.data, 'Could not save the chat');
  }
  const keep = new Set(messages.map((message) => message.id));
  const stale = [...byId.keys()].filter((rowId) => !keep.has(rowId));
  if (stale.length) {
    const params = new URLSearchParams({ id: `in.(${stale.join(',')})`, user_id: `eq.${owner.userId}` });
    const removed = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`, { method: 'DELETE' });
    if (!removed.ok) throw dbError(owner, removed.data, 'Could not save the chat');
  }
  const now = new Date().toISOString();
  if (messages.length) {
    pending.delete(id);
  } else {
    pending.set(id, { ...meta, updatedAt: now });
  }
  return { ...meta, updatedAt: now, messages: saved };
}

async function renameChat(owner: Owner, id: string, title: string): Promise<ConversationMeta | null> {
  const draft = ownerDrafts(owner).get(id);
  if (draft) {
    const next = { ...draft, title, titledByModel: true, updatedAt: new Date().toISOString() };
    ownerDrafts(owner).set(id, next);
    return next;
  }
  const params = new URLSearchParams({ chat_id: `eq.${id}`, user_id: `eq.${owner.userId}` });
  const updated = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`, {
    method: 'PATCH',
    body: JSON.stringify({ chat_title: title, titled_by_model: true }),
  });
  if (!updated.ok) throw dbError(owner, updated.data, 'Could not rename the chat');
  return readMeta(owner, id);
}

async function deleteChat(owner: Owner, id: string): Promise<boolean> {
  if (ownerDrafts(owner).delete(id)) return true;
  const params = new URLSearchParams({ chat_id: `eq.${id}`, user_id: `eq.${owner.userId}`, select: 'id,image_urls' });
  const removed = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  });
  if (!removed.ok) throw dbError(owner, removed.data, 'Could not delete the chat');
  const deleted = rows(removed.data);
  const keys = deleted.flatMap((row) => splitUrls(row.image_urls)).flatMap((url) => {
    const key = storedKey(url);
    return key ? [key] : [];
  });
  await Promise.allSettled(
    keys.map((key) => storageFetch(owner.fetchImpl, owner, objectPath(IMAGE_BUCKET, key), { method: 'DELETE' }, true)),
  );
  return deleted.length > 0;
}

/** Uploads the message's inline images and returns the URLs to keep in `image_urls`. */
async function storeImages(owner: Owner, chatId: string, message: StoredMessage): Promise<string[]> {
  const sources =
    message.role === 'user'
      ? message.image?.url
        ? [message.image.url]
        : message.image?.data && message.image.mediaType
          ? [`data:${message.image.mediaType};base64,${message.image.data}`]
          : []
      : (message.generated ?? []).map((item) => item.url);
  const urls: string[] = [];
  for (const [index, source] of sources.entries()) {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      urls.push(source);
      continue;
    }
    if (source.startsWith(`${IMAGE_ROUTE}?key=`)) {
      const key = new URLSearchParams(source.slice(IMAGE_ROUTE.length + 1)).get('key') ?? '';
      if (key.startsWith(`${userFolder(owner)}/`)) urls.push(`${owner.apiUrl}${objectPath(IMAGE_BUCKET, key)}`);
      continue;
    }
    const match = DATA_URL.exec(source);
    if (!match) continue;
    const mediaType = match[1] ?? 'image/png';
    const bytes = Buffer.from((match[2] ?? '').replace(/\s/g, ''), 'base64');
    if (!bytes.length) continue;
    await ensureOnce(`bucket\n${owner.apiUrl}\n${owner.projectId}`, () => createImageBucket(owner));
    const filename = `${message.id}-${index}.${imageExtension(mediaType)}`;
    const key = `${userFolder(owner)}/${chatId}/${filename}`;
    let uploaded: unknown;
    try {
      uploaded = await putObject(owner.fetchImpl, owner, IMAGE_BUCKET, key, bytes, mediaType, filename);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'upload failed';
      throw new ConfigError(redact(`Could not save the chat image (${reason})`, owner.apiKey), 502);
    }
    const returned =
      uploaded && typeof uploaded === 'object' && typeof (uploaded as { url?: unknown }).url === 'string'
        ? (uploaded as { url: string }).url
        : '';
    urls.push(returned || `${owner.apiUrl}${objectPath(IMAGE_BUCKET, key)}`);
  }
  return urls;
}

function userFolder(owner: Owner): string {
  return owner.userId.replace(/[^A-Za-z0-9_-]/g, '_') || 'user';
}

function imageExtension(mediaType: string): string {
  const subtype = mediaType.split('/')[1] ?? '';
  if (subtype === 'jpeg') return 'jpg';
  return /^[a-z0-9]+$/.test(subtype) ? subtype : 'bin';
}

function storedKey(url: string): string {
  const match = STORED_OBJECT.exec(url);
  if (!match?.[1]) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return '';
  }
}

/** Storage objects need the project key, so the browser loads them through the BFF. */
function viewUrl(url: string): string {
  const key = storedKey(url);
  return key ? `${IMAGE_ROUTE}?key=${encodeURIComponent(key)}` : url;
}

function splitUrls(value: unknown): string[] {
  return typeof value === 'string' ? value.split('\n').map((url) => url.trim()).filter(Boolean) : [];
}

function groupChats(list: MessageRow[]): Map<string, ConversationMeta> {
  const chats = new Map<string, ConversationMeta>();
  for (const row of list) {
    if (typeof row.chat_id !== 'string' || typeof row.updated_at !== 'string') continue;
    const createdAt = typeof row.created_at === 'string' ? row.created_at : row.updated_at;
    const found = chats.get(row.chat_id);
    if (!found) {
      chats.set(row.chat_id, {
        id: row.chat_id,
        title: typeof row.chat_title === 'string' && row.chat_title ? row.chat_title : DEFAULT_TITLE,
        createdAt,
        updatedAt: row.updated_at,
        ...(row.titled_by_model === true ? { titledByModel: true } : {}),
      });
      continue;
    }
    if (createdAt < found.createdAt) found.createdAt = createdAt;
    if (row.updated_at > found.updatedAt) found.updatedAt = row.updated_at;
  }
  return chats;
}

function rowMessage(row: MessageRow): StoredMessage[] {
  if (typeof row.id !== 'string' || (row.role !== 'user' && row.role !== 'assistant')) return [];
  const urls = splitUrls(row.image_urls).map(viewUrl);
  const content = typeof row.content === 'string' ? row.content : '';
  if (row.role === 'user') {
    return [{ id: row.id, role: 'user', content, ...(urls[0] ? { image: { url: urls[0] } } : {}) }];
  }
  return [{ id: row.id, role: 'assistant', content, ...(urls.length ? { generated: urls.map((url) => ({ url })) } : {}) }];
}

/** A new table answers 404 until the records API reloads its schema cache, which takes about a second. */
async function db(
  owner: Owner,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const records = path.startsWith('/api/database/records/');
  for (let attempt = 0; ; attempt += 1) {
    const result = await dbOnce(owner, path, init);
    if (!records || result.status !== 404 || attempt >= 12) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function dbOnce(
  owner: Owner,
  path: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${owner.apiKey}`);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let upstream: Response;
  try {
    upstream = await owner.fetchImpl(`${owner.apiUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${owner.apiUrl} (${redact(reason, owner.apiKey)})`, 502);
  }
  return { ok: upstream.ok, status: upstream.status, data: await readJsonSafe(upstream) };
}

function dbError(owner: Owner, data: unknown, fallback: string): ConfigError {
  return new ConfigError(redact(readErrorMessage(data, fallback), owner.apiKey), 502);
}

function rows(data: unknown): MessageRow[] {
  return Array.isArray(data) ? data.filter((item): item is MessageRow => Boolean(item) && typeof item === 'object') : [];
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigError('Expected JSON');
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ConfigError('Expected JSON');
  }
}

async function readJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function redact(message: string, apiKey: string): string {
  return apiKey ? message.split(apiKey).join('[redacted]') : message;
}
