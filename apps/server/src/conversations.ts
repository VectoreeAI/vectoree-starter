import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { ConfigError, type AppConfig } from './config.js';
import { resolveScope } from './scope.js';
import { readSession } from './session.js';
import { FALLBACK_MODEL, readErrorMessage } from './vectoree.js';

/** One row per chat. Every conversation for the connected project lives in this table. */
const CHAT_TABLE = 'starter_chats';

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 40;
const MAX_CONTENT = 16_000;
const MAX_IMAGE_CHARS = 120_000;
const MAX_GENERATED_DATA_URL = 800_000;
const MAX_HTTP_URL = 8_000;
const MAX_BODY = 1_500_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  image?: { mediaType: string; data?: string };
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

type ChatRow = {
  id?: unknown;
  user_id?: unknown;
  title?: unknown;
  titled_by_model?: unknown;
  messages?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
};

const ensured = new Map<string, Promise<void>>();

const locks = new Map<string, Promise<void>>();

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
        const index = await readIndex(owner);
        if (record.force !== true) {
          const reusable = index.find((item) => item.title === DEFAULT_TITLE && !item.titledByModel);
          if (reusable) {
            const existing = await readConversation(owner, reusable.id);
            if (existing && existing.messages.length === 0) return existing;
          }
        }
        if (index.length >= MAX_CONVERSATIONS) throw new ConfigError('Too many conversations');
        const now = new Date().toISOString();
        const conversation: Conversation = {
          id: randomUUID(),
          title,
          createdAt: now,
          updatedAt: now,
          messages: [],
        };
        await writeConversation(owner, conversation);
        return conversation;
      });
      return c.json(conversationMeta(created), 201);
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
      const saved = await withLock(lockKey(owner), async () => {
        const current = await readConversation(owner, id);
        if (!current) return null;
        const next: Conversation = { ...current, messages, updatedAt: new Date().toISOString() };
        await writeConversation(owner, next);
        return next;
      });
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json(conversationMeta(saved));
    }),
  );

  app.patch('/api/conversations/:id', async (c) =>
    withUser(c, deps, async (owner) => {
      const id = conversationId(c.req.param('id'));
      const body = await readJson(c);
      const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
      if (typeof record.title !== 'string' || !record.title.trim()) throw new ConfigError('title is required');
      const title = sanitizeTitle(record.title);
      const saved = await withLock(lockKey(owner), async () => {
        const current = await readConversation(owner, id);
        if (!current) return null;
        const next: Conversation = { ...current, title, titledByModel: true, updatedAt: new Date().toISOString() };
        await writeConversation(owner, next);
        return next;
      });
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json(conversationMeta(saved));
    }),
  );

  app.delete('/api/conversations/:id', (c) =>
    withUser(c, deps, async (owner) => {
      const id = conversationId(c.req.param('id'));
      const removed = await withLock(lockKey(owner), async () => deleteConversation(owner, id));
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
      const saved = await withLock(lockKey(owner), async () => {
        const latest = await readConversation(owner, id);
        if (!latest) return null;
        const next: Conversation = {
          ...latest,
          title,
          titledByModel: true,
          updatedAt: new Date().toISOString(),
        };
        await writeConversation(owner, next);
        return next;
      });
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json({ id: saved.id, title: saved.title });
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
  await ensureChatTable(owner);
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
  return messages.map((item) => {
    if (!item || typeof item !== 'object') throw new ConfigError('Invalid message');
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || id.length > 80 || id.includes('/') || id.includes('..')) throw new ConfigError('Invalid message id');
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

function parseImage(value: unknown): { mediaType: string; data?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
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
  return '';
}

function conversationMeta(conversation: Conversation): ConversationMeta {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...(conversation.titledByModel ? { titledByModel: true } : {}),
  };
}

function lockKey(owner: Owner): string {
  return `${owner.projectId}:${owner.userId}`;
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

async function ensureChatTable(owner: Owner): Promise<void> {
  const key = `${owner.apiUrl}\n${owner.projectId}`;
  let pending = ensured.get(key);
  if (!pending) {
    pending = createChatTable(owner).catch((error: unknown) => {
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
  const created = await db(owner, '/api/database/tables', {
    method: 'POST',
    body: JSON.stringify({
      tableName: CHAT_TABLE,
      rlsEnabled: false,
      columns: [
        { columnName: 'user_id', type: 'string', isNullable: false, isUnique: false },
        { columnName: 'title', type: 'string', isNullable: false, isUnique: false },
        { columnName: 'titled_by_model', type: 'boolean', isNullable: false, isUnique: false },
        { columnName: 'messages', type: 'json', isNullable: false, isUnique: false },
      ],
    }),
  });
  if (created.ok) return;
  const message = readErrorMessage(created.data, 'Could not create starter_chats');
  if (created.status === 400 && /already exists/i.test(message)) return;
  throw dbError(owner, created.data, 'Could not create starter_chats');
}

async function readIndex(owner: Owner): Promise<ConversationMeta[]> {
  const params = new URLSearchParams({
    user_id: `eq.${owner.userId}`,
    order: 'updated_at.desc',
    limit: String(MAX_CONVERSATIONS),
    select: 'id,title,titled_by_model,created_at,updated_at',
  });
  const result = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`);
  if (!result.ok) throw dbError(owner, result.data, 'Could not list chats');
  return rows(result.data).flatMap((row) => {
    const meta = rowMeta(row);
    return meta ? [meta] : [];
  });
}

async function readConversation(owner: Owner, id: string): Promise<Conversation | null> {
  const params = new URLSearchParams({
    id: `eq.${id}`,
    user_id: `eq.${owner.userId}`,
    limit: '1',
  });
  const result = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`);
  if (!result.ok) throw dbError(owner, result.data, 'Could not load the chat');
  const row = rows(result.data)[0];
  if (!row) return null;
  return rowConversation(row, id);
}

async function writeConversation(owner: Owner, conversation: Conversation): Promise<void> {
  const existing = await readConversation(owner, conversation.id);
  const body = {
    title: conversation.title,
    titled_by_model: Boolean(conversation.titledByModel),
    messages: conversation.messages,
  };
  if (!existing) {
    const created = await db(owner, `/api/database/records/${CHAT_TABLE}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify([{ id: conversation.id, user_id: owner.userId, ...body }]),
    });
    if (!created.ok) throw dbError(owner, created.data, 'Could not save the chat');
    return;
  }
  const params = new URLSearchParams({ id: `eq.${conversation.id}`, user_id: `eq.${owner.userId}` });
  const updated = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!updated.ok) throw dbError(owner, updated.data, 'Could not save the chat');
}

async function deleteConversation(owner: Owner, id: string): Promise<boolean> {
  const params = new URLSearchParams({ id: `eq.${id}`, user_id: `eq.${owner.userId}` });
  const removed = await db(owner, `/api/database/records/${CHAT_TABLE}?${params}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  });
  if (!removed.ok) throw dbError(owner, removed.data, 'Could not delete the chat');
  return Array.isArray(removed.data) && removed.data.length > 0;
}

async function db(
  owner: Owner,
  path: string,
  init: RequestInit = {},
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

function rows(data: unknown): ChatRow[] {
  return Array.isArray(data) ? data.filter((item): item is ChatRow => Boolean(item) && typeof item === 'object') : [];
}

function rowMeta(row: ChatRow): ConversationMeta | null {
  if (typeof row.id !== 'string' || typeof row.title !== 'string') return null;
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : '';
  const createdAt = typeof row.created_at === 'string' ? row.created_at : updatedAt;
  if (!updatedAt) return null;
  return {
    id: row.id,
    title: row.title,
    createdAt,
    updatedAt,
    ...(row.titled_by_model === true ? { titledByModel: true } : {}),
  };
}

function rowConversation(row: ChatRow, id: string): Conversation | null {
  const meta = rowMeta(row);
  if (!meta || meta.id !== id) return null;
  const messages = parseStoredMessages(row.messages);
  if (!messages) return null;
  return { ...meta, messages };
}

function parseStoredMessages(value: unknown): StoredMessage[] | null {
  const parsed = typeof value === 'string' ? parseJson(value) : value;
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as StoredMessage;
    if (typeof record.id !== 'string' || (record.role !== 'user' && record.role !== 'assistant')) return [];
    return [record];
  });
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
