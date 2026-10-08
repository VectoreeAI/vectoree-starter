import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import { ConfigError, type AppConfig } from './config.js';
import { resolveScope } from './scope.js';
import { readSession } from './session.js';
import { FALLBACK_MODEL, readErrorMessage } from './vectoree.js';

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

/** projectId is set in cloud mode only; local history keeps the per-user path. */
type Owner = { root: string; userId: string; projectId?: string };

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
        await writeConversation(owner, conversation, [conversationMeta(conversation), ...index]);
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
        const index = await readIndex(owner);
        const next: Conversation = { ...current, messages, updatedAt: new Date().toISOString() };
        await writeConversation(owner, next, sortIndex(replaceMeta(index, next)));
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
        const index = await readIndex(owner);
        const next: Conversation = { ...current, title, titledByModel: true, updatedAt: new Date().toISOString() };
        await writeConversation(owner, next, sortIndex(replaceMeta(index, next)));
        return next;
      });
      if (!saved) return c.json({ message: 'Conversation not found' }, 404);
      return c.json(conversationMeta(saved));
    }),
  );

  app.delete('/api/conversations/:id', (c) =>
    withUser(c, deps, async (owner) => {
      const id = conversationId(c.req.param('id'));
      const removed = await withLock(lockKey(owner), async () => {
        const index = await readIndex(owner);
        if (!index.some((item) => item.id === id)) return false;
        await writeIndex(
          owner,
          index.filter((item) => item.id !== id),
        );
        fs.rmSync(conversationPath(owner, id), { force: true });
        return true;
      });
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
        const index = await readIndex(owner);
        const next: Conversation = {
          ...latest,
          title,
          titledByModel: true,
          updatedAt: new Date().toISOString(),
        };
        await writeConversation(owner, next, sortIndex(replaceMeta(index, next)));
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
  const owner: Owner = {
    root: deps.root,
    userId: session.user.id,
    ...(config.conversationProjectId ? { projectId: config.conversationProjectId } : {}),
  };
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

function replaceMeta(index: ConversationMeta[], conversation: Conversation): ConversationMeta[] {
  const meta = conversationMeta(conversation);
  const rest = index.filter((item) => item.id !== conversation.id);
  return [meta, ...rest];
}

function sortIndex(index: ConversationMeta[]): ConversationMeta[] {
  return [...index].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

function lockKey(owner: Owner): string {
  return owner.projectId ? `${owner.projectId}:${owner.userId}` : owner.userId;
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

function safeSegment(value: string, label: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  if (!safe) throw new ConfigError(`Invalid ${label}`);
  return safe;
}

function userDirectory(owner: Owner): string {
  const base = path.join(owner.root, '.vectoree', 'conversations');
  const user = safeSegment(owner.userId, 'user');
  return owner.projectId ? path.join(base, safeSegment(owner.projectId, 'project'), user) : path.join(base, user);
}

function conversationPath(owner: Owner, id: string): string {
  return path.join(userDirectory(owner), `${id}.json`);
}

async function readIndex(owner: Owner): Promise<ConversationMeta[]> {
  const file = path.join(userDirectory(owner), 'index.json');
  if (!fs.existsSync(file)) return [];
  const parsed = parseJson(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isMeta);
}

async function readConversation(owner: Owner, id: string): Promise<Conversation | null> {
  const file = conversationPath(owner, id);
  if (!fs.existsSync(file)) return null;
  const parsed = parseJson(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Conversation;
  if (record.id !== id || !Array.isArray(record.messages)) return null;
  return record;
}

async function writeConversation(owner: Owner, conversation: Conversation, index: ConversationMeta[]): Promise<void> {
  const dir = userDirectory(owner);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, `${conversation.id}.json`), conversation);
  writeJson(path.join(dir, 'index.json'), index);
}

async function writeIndex(owner: Owner, index: ConversationMeta[]): Promise<void> {
  const dir = userDirectory(owner);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJson(path.join(dir, 'index.json'), index);
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isMeta(value: unknown): value is ConversationMeta {
  if (!value || typeof value !== 'object') return false;
  const record = value as ConversationMeta;
  return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.updatedAt === 'string';
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
