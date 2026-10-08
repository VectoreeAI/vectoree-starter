import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ConfigError, type AppConfig } from './config.js';
import { resolveScope } from './scope.js';
import { readSession } from './session.js';
import { readErrorMessage } from './vectoree.js';

const BUCKET_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_BYTES = 8 * 1024 * 1024;

export type StorageAuth = { apiUrl: string; apiKey: string };
export type StorageMutation = { action: 'buckets_changed' | 'objects_changed'; bucket?: string };
export type StorageBucket = { name: string; isPublic?: boolean; createdAt?: string };
export type StorageObject = { key: string; size?: number; mimeType?: string; uploadedAt?: string; url?: string };

type Deps = {
  root: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
};

export function mountStorage(app: Hono, deps: Deps): void {
  app.get('/api/storage/buckets', (c) =>
    withSession(c, deps, async (config) => {
      const data = await readOk(deps.fetchImpl, config, '/api/storage/buckets', 'Could not list buckets');
      return c.json({ buckets: normalizeBuckets(data) });
    }),
  );

  app.post('/api/storage/buckets', (c) =>
    withSession(c, deps, async (config) => {
      const body = parseCreateBucket(await readJson(c));
      const data = await readOk(deps.fetchImpl, config, '/api/storage/buckets', 'Could not create the bucket', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return c.json(data && typeof data === 'object' ? data : { ok: true });
    }),
  );

  app.patch('/api/storage/buckets/:bucket', (c) =>
    withSession(c, deps, async (config) => {
      const bucket = bucketName(c.req.param('bucket'));
      const body = await readJson(c);
      const isPublic = body && typeof body === 'object' ? (body as { isPublic?: unknown }).isPublic : undefined;
      if (typeof isPublic !== 'boolean') throw new ConfigError('isPublic must be a boolean');
      const data = await readOk(deps.fetchImpl, config, `/api/storage/buckets/${encodeURIComponent(bucket)}`, 'Could not update the bucket', {
        method: 'PATCH',
        body: JSON.stringify({ isPublic }),
      });
      return c.json(data && typeof data === 'object' ? data : { ok: true });
    }),
  );

  app.delete('/api/storage/buckets/:bucket', (c) =>
    withSession(c, deps, async (config) => {
      const bucket = bucketName(c.req.param('bucket'));
      await readOk(deps.fetchImpl, config, `/api/storage/buckets/${encodeURIComponent(bucket)}`, 'Could not delete the bucket', {
        method: 'DELETE',
      });
      return c.json({ ok: true });
    }),
  );

  app.get('/api/storage/buckets/:bucket/objects', (c) =>
    withSession(c, deps, async (config) => {
      const bucket = bucketName(c.req.param('bucket'));
      const data = await readOk(deps.fetchImpl, config, objectListPath(bucket, c.req.query()), 'Could not list objects');
      return c.json(normalizeObjects(data));
    }),
  );

  app.post('/api/storage/buckets/:bucket/objects', (c) =>
    withSession(c, deps, async (config) => {
      const bucket = bucketName(c.req.param('bucket'));
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw new ConfigError('Expected a file');
      if (file.size > MAX_BYTES) throw new ConfigError('File is too large');
      const named = typeof form.key === 'string' ? form.key : file.name;
      const key = objectKey(named);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = await putObject(deps.fetchImpl, config, bucket, key, bytes, file.type || 'application/octet-stream', file.name);
      return c.json(data ?? { key });
    }),
  );

  app.get('/api/storage/buckets/:bucket/objects/content', (c) =>
    withSession(c, deps, async (config) => {
      const bucket = bucketName(c.req.param('bucket'));
      const key = objectKey(c.req.query('key') ?? '');
      const upstream = await storageFetch(deps.fetchImpl, config, objectPath(bucket, key), { method: 'GET' }, false);
      if (!upstream.ok) {
        const data = await readJsonSafe(upstream);
        return fail(c, upstream.status, data, 'Could not download the object');
      }
      const filename = key.split('/').pop() || 'download';
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
        },
      });
    }),
  );

  app.delete('/api/storage/buckets/:bucket/objects', (c) =>
    withSession(c, deps, async (config) => {
      const bucket = bucketName(c.req.param('bucket'));
      const key = objectKey(c.req.query('key') ?? '');
      await readOk(deps.fetchImpl, config, objectPath(bucket, key), 'Could not delete the object', { method: 'DELETE' });
      return c.json({ ok: true });
    }),
  );
}

export async function executeStorageTool(
  fetchImpl: typeof fetch,
  auth: StorageAuth,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; mutation?: StorageMutation }> {
  try {
    if (name === 'list_buckets') {
      const data = await readOk(fetchImpl, auth, '/api/storage/buckets', 'Could not list buckets');
      return { result: { buckets: normalizeBuckets(data) } };
    }
    if (name === 'create_bucket') {
      const body = parseCreateBucket(args);
      const data = await readOk(fetchImpl, auth, '/api/storage/buckets', 'Could not create the bucket', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { result: data ?? { ok: true }, mutation: { action: 'buckets_changed' } };
    }
    if (name === 'delete_bucket') {
      const bucket = bucketName(textArg(args, 'bucketName') || textArg(args, 'bucket'));
      await readOk(fetchImpl, auth, `/api/storage/buckets/${encodeURIComponent(bucket)}`, 'Could not delete the bucket', {
        method: 'DELETE',
      });
      return { result: { ok: true }, mutation: { action: 'buckets_changed' } };
    }
    if (name === 'list_objects') {
      const bucket = bucketName(textArg(args, 'bucket') || textArg(args, 'bucketName'));
      const data = await readOk(fetchImpl, auth, objectListPath(bucket, args), 'Could not list objects');
      return { result: normalizeObjects(data) };
    }
    if (name === 'upload_object') {
      const bucket = bucketName(textArg(args, 'bucket') || textArg(args, 'bucketName'));
      const uploaded = await bytesFromArgs(fetchImpl, args);
      const key = objectKey(textArg(args, 'key') || uploaded.defaultKey);
      const data = await putObject(fetchImpl, auth, bucket, key, uploaded.bytes, uploaded.contentType, key.split('/').pop() || 'file');
      return { result: data ?? { key }, mutation: { action: 'objects_changed', bucket } };
    }
    if (name === 'delete_object') {
      const bucket = bucketName(textArg(args, 'bucket') || textArg(args, 'bucketName'));
      const key = objectKey(textArg(args, 'key'));
      await readOk(fetchImpl, auth, objectPath(bucket, key), 'Could not delete the object', { method: 'DELETE' });
      return { result: { ok: true }, mutation: { action: 'objects_changed', bucket } };
    }
    if (name === 'get_object_info') {
      const bucket = bucketName(textArg(args, 'bucket') || textArg(args, 'bucketName'));
      const key = objectKey(textArg(args, 'key'));
      const data = await readOk(fetchImpl, auth, objectListPath(bucket, { search: key, limit: 50 }), 'Could not look up the object');
      const found = normalizeObjects(data).objects.find((item) => item.key === key);
      if (!found) return { result: { error: 'Object not found' } };
      return { result: found };
    }
    return { result: { error: `Unsupported tool ${name}` } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Storage tool failed';
    return { result: { error: message.split(auth.apiKey).join('[redacted]') } };
  }
}

export function bucketName(value: string): string {
  const name = value.trim();
  if (!BUCKET_NAME.test(name)) {
    throw new ConfigError('Invalid bucket name: use ASCII letters, digits, underscore, or hyphen (e.g. demo)');
  }
  return name;
}

export function objectKey(value: string): string {
  const key = value.trim();
  if (!key || key.split('/').some((part) => part === '..' || part === '.')) {
    throw new ConfigError('Invalid object key');
  }
  return key;
}

export function normalizeBuckets(data: unknown): StorageBucket[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { buckets?: unknown }).buckets)
      ? (data as { buckets: unknown[] }).buckets
      : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : [];
  return list.flatMap((item) => {
    if (typeof item === 'string' && item.trim()) return [{ name: item.trim() }];
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const name = textArg(record, 'name') || textArg(record, 'bucketName');
    if (!name) return [];
    const isPublic = typeof record.isPublic === 'boolean' ? record.isPublic : typeof record.public === 'boolean' ? record.public : undefined;
    const createdAt = textArg(record, 'createdAt');
    return [{ name, ...(isPublic !== undefined ? { isPublic } : {}), ...(createdAt ? { createdAt } : {}) }];
  });
}

export function normalizeObjects(data: unknown): { objects: StorageObject[]; pagination?: { offset: number; limit: number; total: number } } {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(data)
    ? data
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.objects)
        ? record.objects
        : [];
  const objects = list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const key = textArg(row, 'key');
    if (!key) return [];
    const mime = textArg(row, 'mimeType') || textArg(row, 'mime');
    const uploadedAt = textArg(row, 'uploadedAt');
    const url = textArg(row, 'url');
    return [
      {
        key,
        ...(typeof row.size === 'number' ? { size: row.size } : {}),
        ...(mime ? { mimeType: mime } : {}),
        ...(uploadedAt ? { uploadedAt } : {}),
        ...(url ? { url } : {}),
      },
    ];
  });
  const page = record.pagination;
  const pagination =
    page && typeof page === 'object'
      ? {
          offset: numberField((page as { offset?: unknown }).offset),
          limit: numberField((page as { limit?: unknown }).limit),
          total: numberField((page as { total?: unknown }).total),
        }
      : undefined;
  return { objects, ...(pagination ? { pagination } : {}) };
}

function parseCreateBucket(body: unknown): { bucketName: string; isPublic?: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConfigError('Expected a bucket definition');
  const record = body as Record<string, unknown>;
  const name = bucketName(textArg(record, 'bucketName') || textArg(record, 'name'));
  const isPublic = typeof record.isPublic === 'boolean' ? record.isPublic : undefined;
  return { bucketName: name, ...(isPublic !== undefined ? { isPublic } : {}) };
}

async function bytesFromArgs(
  fetchImpl: typeof fetch,
  args: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; contentType: string; defaultKey: string }> {
  const contentType = textArg(args, 'contentType');
  if (typeof args.textContent === 'string') {
    const bytes = new TextEncoder().encode(args.textContent);
    if (bytes.byteLength > MAX_BYTES) throw new ConfigError('File is too large');
    return { bytes, contentType: contentType || 'text/plain; charset=utf-8', defaultKey: 'notes/hello.txt' };
  }
  if (typeof args.contentBase64 === 'string' && args.contentBase64.trim()) {
    const bytes = Uint8Array.from(Buffer.from(args.contentBase64, 'base64'));
    if (bytes.byteLength > MAX_BYTES) throw new ConfigError('File is too large');
    return { bytes, contentType: contentType || 'application/octet-stream', defaultKey: 'notes/hello.txt' };
  }
  const sourceUrl = textArg(args, 'sourceUrl');
  if (sourceUrl) {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ConfigError('sourceUrl must be http or https');
    const remote = await fetchImpl(sourceUrl, { signal: AbortSignal.timeout(20_000) });
    if (!remote.ok) throw new ConfigError(`Could not fetch sourceUrl (${remote.status})`);
    const bytes = new Uint8Array(await remote.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new ConfigError('File is too large');
    const base = decodeURIComponent(parsed.pathname.split('/').pop() || '') || 'notes/hello.txt';
    return { bytes, contentType: contentType || remote.headers.get('content-type') || 'application/octet-stream', defaultKey: base };
  }
  throw new ConfigError('upload_object needs textContent, contentBase64, or sourceUrl');
}

async function putObject(
  fetchImpl: typeof fetch,
  auth: StorageAuth,
  bucket: string,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  filename: string,
) {
  const form = new FormData();
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  form.append('file', new Blob([copy], { type: contentType }), filename);
  const upstream = await storageFetch(fetchImpl, auth, objectPath(bucket, key), { method: 'PUT', body: form }, true);
  const data = await readJsonSafe(upstream);
  if (!upstream.ok) throw new ConfigError(readErrorMessage(data, 'Could not upload the object'));
  return data;
}

function objectPath(bucket: string, key: string): string {
  return `/api/storage/buckets/${encodeURIComponent(bucket)}/objects/${encodeURIComponent(key)}`;
}

function objectListPath(bucket: string, query: Record<string, unknown> | { prefix?: string; limit?: string; offset?: string; search?: string }): string {
  const params = new URLSearchParams();
  const prefix = textArg(query, 'prefix');
  const search = textArg(query, 'search');
  const limit = textArg(query, 'limit');
  const offset = textArg(query, 'offset');
  if (prefix) params.set('prefix', prefix);
  if (search) params.set('search', search);
  if (limit) params.set('limit', limit);
  if (offset) params.set('offset', offset);
  const suffix = params.toString();
  return `/api/storage/buckets/${encodeURIComponent(bucket)}/objects${suffix ? `?${suffix}` : ''}`;
}

async function withSession(
  c: Context,
  deps: Deps,
  run: (config: AppConfig & { apiKey: string }) => Promise<Response>,
): Promise<Response> {
  const config = resolveScope(c, deps.root, deps.env);
  if (!readSession(c)) return c.json({ message: 'Sign in required' }, 401);
  return run(config);
}

async function readOk(fetchImpl: typeof fetch, auth: StorageAuth, path: string, fallback: string, init: RequestInit = {}) {
  const upstream = await storageFetch(fetchImpl, auth, path, init, true);
  const data = await readJsonSafe(upstream);
  if (!upstream.ok) throw new ConfigError(readErrorMessage(data, fallback));
  return data;
}

async function storageFetch(fetchImpl: typeof fetch, auth: StorageAuth, path: string, init: RequestInit, json: boolean) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${auth.apiKey}`);
  if (json) headers.set('Accept', 'application/json');
  if (init.body && json && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  try {
    return await fetchImpl(`${auth.apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${auth.apiUrl} (${reason})`, 502);
  }
}

function textArg(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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

function fail(c: Context, status: number, data: unknown, fallback: string): Response {
  return c.json({ message: readErrorMessage(data, fallback) }, statusOf(status));
}

function statusOf(status: number): ContentfulStatusCode {
  if (status >= 200 && status <= 599) return status as ContentfulStatusCode;
  return 502;
}
