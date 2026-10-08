import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ConfigError, type AppConfig } from './config.js';
import { resolveScope } from './scope.js';
import { readSession } from './session.js';
import { readErrorMessage } from './vectoree.js';

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RECORD_ID = /^[A-Za-z0-9_-]+$/;
const ORDER = /^[A-Za-z_][A-Za-z0-9_]*\.(asc|desc)$/;
const COLUMN_TYPES = new Set(['string', 'date', 'datetime', 'integer', 'float', 'boolean', 'uuid', 'json']);
const RESERVED_COLUMNS: Record<string, string> = {
  id: 'uuid',
  created_at: 'datetime',
  updated_at: 'datetime',
};

export type DbAuth = { apiUrl: string; apiKey: string };
export type DbMutation = { action: 'tables_changed' | 'records_changed'; table?: string };

export type CreateTableColumn = {
  columnName: string;
  type: string;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue?: string;
};

export type CreateTableBody = {
  tableName: string;
  columns: CreateTableColumn[];
  rlsEnabled: boolean;
};

type Deps = {
  root: string;
  env: NodeJS.ProcessEnv;
  fetchImpl: typeof fetch;
};

export function mountDatabase(app: Hono, deps: Deps): void {
  app.post('/api/database/tables', (c) =>
    withSession(c, deps, async (config) => {
      const body = parseCreateTable(await readJson(c));
      const upstream = await dbFetch(deps.fetchImpl, config, '/api/database/tables', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const data = await readJsonSafe(upstream);
      if (!upstream.ok) return fail(c, upstream.status, data, 'Could not create the table');
      return c.json(data && typeof data === 'object' ? data : { ok: true });
    }),
  );

  app.get('/api/database/tables', (c) =>
    withSession(c, deps, async (config) => {
      const upstream = await dbFetch(deps.fetchImpl, config, '/api/database/tables');
      const data = await readJsonSafe(upstream);
      if (!upstream.ok) return fail(c, upstream.status, data, 'Could not list tables');
      const tables = Array.isArray(data)
        ? data.filter((item): item is string => typeof item === 'string')
        : [];
      return c.json({ tables });
    }),
  );

  app.get('/api/database/tables/:table/schema', (c) =>
    withSession(c, deps, async (config) => {
      const table = tableName(c.req.param('table'));
      const upstream = await dbFetch(deps.fetchImpl, config, `/api/database/tables/${table}/schema`);
      const data = await readJsonSafe(upstream);
      if (!upstream.ok) return fail(c, upstream.status, data, 'Could not load the table schema');
      return c.json(normalizeSchema(table, data));
    }),
  );

  app.get('/api/database/tables/:table/records', (c) =>
    withSession(c, deps, async (config) => {
      const table = tableName(c.req.param('table'));
      const limit = clampInt(c.req.query('limit'), 50, 1, 100);
      const offset = clampInt(c.req.query('offset'), 0, 0, 100_000);
      const order = c.req.query('order');
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (order && ORDER.test(order)) params.set('order', order);
      const upstream = await dbFetch(deps.fetchImpl, config, `/api/database/records/${table}?${params}`);
      const data = await readJsonSafe(upstream);
      if (!upstream.ok) return fail(c, upstream.status, data, 'Could not list records');
      const records = Array.isArray(data) ? data.filter((item) => item && typeof item === 'object') : [];
      const totalHeader = upstream.headers.get('x-total-count');
      const total = totalHeader && /^\d+$/.test(totalHeader) ? Number(totalHeader) : undefined;
      return c.json({ records, ...(total !== undefined ? { total } : {}) });
    }),
  );

  app.post('/api/database/tables/:table/records', (c) =>
    withSession(c, deps, async (config) => {
      const table = tableName(c.req.param('table'));
      const rows = asRowArray(await readJson(c));
      const upstream = await dbFetch(deps.fetchImpl, config, `/api/database/records/${table}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
      const data = await readJsonSafe(upstream);
      if (!upstream.ok) return fail(c, upstream.status, data, 'Could not create the record');
      return c.json({ records: Array.isArray(data) ? data : [] });
    }),
  );

  app.patch('/api/database/tables/:table/records/:id', (c) =>
    withSession(c, deps, async (config) => {
      const table = tableName(c.req.param('table'));
      const id = recordId(c.req.param('id'));
      const row = asRow(await readJson(c));
      const upstream = await dbFetch(
        deps.fetchImpl,
        config,
        `/api/database/records/${table}?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(row),
        },
      );
      const data = await readJsonSafe(upstream);
      if (!upstream.ok) return fail(c, upstream.status, data, 'Could not update the record');
      return c.json({ records: Array.isArray(data) ? data : data ? [data] : [] });
    }),
  );

  app.delete('/api/database/tables/:table/records/:id', (c) =>
    withSession(c, deps, async (config) => {
      const table = tableName(c.req.param('table'));
      const id = recordId(c.req.param('id'));
      const upstream = await dbFetch(
        deps.fetchImpl,
        config,
        `/api/database/records/${table}?id=eq.${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      );
      if (!upstream.ok) {
        const data = await readJsonSafe(upstream);
        return fail(c, upstream.status, data, 'Could not delete the record');
      }
      return c.json({ ok: true });
    }),
  );
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

function tableName(value: string): string {
  if (!TABLE_NAME.test(value)) {
    throw new ConfigError('Invalid table name: use ASCII letters, digits, underscore (e.g. demo_items)');
  }
  return value;
}

function recordId(value: string): string {
  if (!RECORD_ID.test(value) || value.includes('..')) throw new ConfigError('Invalid record id');
  return value;
}

function asRow(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConfigError('Expected a record object');
  return body as Record<string, unknown>;
}

function asRowArray(body: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(body) ? body : [body];
  if (rows.length === 0) throw new ConfigError('Expected a record');
  return rows.map((row) => asRow(row));
}

export function normalizeSchema(table: string, data: unknown): {
  tableName: string;
  columns: Array<{
    name: string;
    columnName: string;
    type: string;
    nullable: boolean;
    isNullable: boolean;
    isUnique: boolean;
    isPrimaryKey?: boolean;
  }>;
} {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const tableName =
    typeof record.tableName === 'string'
      ? record.tableName
      : typeof record.table_name === 'string'
        ? record.table_name
        : table;
  const raw = Array.isArray(record.columns) ? record.columns : [];
  const columns = raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const column = item as Record<string, unknown>;
    const columnName = textField(column.columnName) || textField(column.name);
    if (!columnName) return [];
    const isNullable = readBool(column, 'isNullable', 'nullable') ?? true;
    const isUnique = readBool(column, 'isUnique', 'unique') ?? false;
    const isPrimaryKey = column.isPrimaryKey === true || column.is_primary_key === true;
    return [
      {
        name: columnName,
        columnName,
        type: typeof column.type === 'string' ? column.type : 'string',
        nullable: isNullable,
        isNullable,
        isUnique,
        ...(isPrimaryKey ? { isPrimaryKey: true } : {}),
      },
    ];
  });
  return { tableName, columns };
}

export function parseCreateTable(body: unknown): CreateTableBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ConfigError('Expected a table definition');
  const record = body as Record<string, unknown>;
  const name = typeof record.tableName === 'string' ? record.tableName.trim() : '';
  if (!TABLE_NAME.test(name)) {
    throw new ConfigError('Invalid table name: use ASCII letters, digits, underscore (e.g. demo_items)');
  }
  if (!Array.isArray(record.columns) || record.columns.length === 0) throw new ConfigError('Columns are required');
  const columns = record.columns.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ConfigError('Invalid column');
    const column = item as Record<string, unknown>;
    const columnName = textField(column.columnName) || textField(column.name);
    if (!TABLE_NAME.test(columnName)) {
      throw new ConfigError('Invalid column name: use ASCII letters, digits, underscore (e.g. title)');
    }
    const type = typeof column.type === 'string' ? column.type : '';
    if (!COLUMN_TYPES.has(type)) throw new ConfigError(`Invalid column type: ${type || 'missing'}`);
    const reserved = RESERVED_COLUMNS[columnName];
    if (reserved) {
      if (type !== reserved) {
        throw new ConfigError(
          `Column '${columnName}' is reserved and must be type '${reserved}', but got '${type}'. Omit id, created_at, and updated_at; the backend adds them.`,
        );
      }
      return [];
    }
    const isNullable = readBool(column, 'isNullable', 'nullable');
    if (isNullable === undefined) throw new ConfigError(`Column '${columnName}' requires isNullable`);
    const parsed: CreateTableColumn = {
      columnName,
      type,
      isNullable,
      isUnique: readBool(column, 'isUnique', 'unique') ?? false,
    };
    if (typeof column.defaultValue === 'string') parsed.defaultValue = column.defaultValue;
    return [parsed];
  });
  if (columns.length === 0) {
    throw new ConfigError('Add at least one column besides id, created_at, and updated_at');
  }
  return {
    tableName: name,
    columns,
    rlsEnabled: typeof record.rlsEnabled === 'boolean' ? record.rlsEnabled : true,
  };
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBool(record: Record<string, unknown>, canonical: string, alias: string): boolean | undefined {
  if (typeof record[canonical] === 'boolean') return record[canonical];
  if (typeof record[alias] === 'boolean') return record[alias];
  return undefined;
}

export async function executeDatabaseTool(
  fetchImpl: typeof fetch,
  auth: DbAuth,
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; mutation?: DbMutation }> {
  try {
    if (name === 'list_tables') {
      const data = await readOk(fetchImpl, auth, '/api/database/tables', 'Could not list tables');
      const tables = Array.isArray(data) ? data.filter((item): item is string => typeof item === 'string') : [];
      return { result: { tables } };
    }
    if (name === 'get_table_schema') {
      const table = tableName(textArg(args, 'table') || textArg(args, 'tableName'));
      const data = await readOk(fetchImpl, auth, `/api/database/tables/${table}/schema`, 'Could not load the table schema');
      return { result: normalizeSchema(table, data) };
    }
    if (name === 'create_table') {
      const body = parseCreateTable(args);
      const data = await readOk(fetchImpl, auth, '/api/database/tables', 'Could not create the table', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { result: data ?? { ok: true }, mutation: { action: 'tables_changed', table: body.tableName } };
    }
    if (name === 'list_records') {
      const table = tableName(textArg(args, 'table') || textArg(args, 'tableName'));
      const limit = clampInt(argText(args.limit), 50, 1, 100);
      const offset = clampInt(argText(args.offset), 0, 0, 100_000);
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      const order = textArg(args, 'order');
      if (order && ORDER.test(order)) params.set('order', order);
      const data = await readOk(fetchImpl, auth, `/api/database/records/${table}?${params}`, 'Could not list records');
      const records = Array.isArray(data) ? data.filter((item) => item && typeof item === 'object') : [];
      return { result: { records } };
    }
    if (name === 'insert_records') {
      const table = tableName(textArg(args, 'table') || textArg(args, 'tableName'));
      const rows = asRowArray(args.records ?? args.rows);
      const data = await readOk(fetchImpl, auth, `/api/database/records/${table}`, 'Could not create the record', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(rows),
      });
      return {
        result: { records: Array.isArray(data) ? data : [] },
        mutation: { action: 'records_changed', table },
      };
    }
    if (name === 'update_record') {
      const table = tableName(textArg(args, 'table') || textArg(args, 'tableName'));
      const id = recordId(textArg(args, 'id'));
      const row = asRow(args.values ?? args.row ?? args.patch);
      const data = await readOk(
        fetchImpl,
        auth,
        `/api/database/records/${table}?id=eq.${encodeURIComponent(id)}`,
        'Could not update the record',
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(row) },
      );
      return {
        result: { records: Array.isArray(data) ? data : data ? [data] : [] },
        mutation: { action: 'records_changed', table },
      };
    }
    if (name === 'delete_record') {
      const table = tableName(textArg(args, 'table') || textArg(args, 'tableName'));
      const id = recordId(textArg(args, 'id'));
      await readOk(
        fetchImpl,
        auth,
        `/api/database/records/${table}?id=eq.${encodeURIComponent(id)}`,
        'Could not delete the record',
        { method: 'DELETE' },
      );
      return { result: { ok: true }, mutation: { action: 'records_changed', table } };
    }
    return { result: { error: `Unsupported tool ${name}` } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Database tool failed';
    return { result: { error: message.split(auth.apiKey).join('[redacted]') } };
  }
}

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function argText(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
}

async function readOk(fetchImpl: typeof fetch, auth: DbAuth, path: string, fallback: string, init: RequestInit = {}) {
  const upstream = await dbFetch(fetchImpl, auth, path, init);
  const data = await readJsonSafe(upstream);
  if (!upstream.ok) throw new ConfigError(readErrorMessage(data, fallback));
  return data;
}

async function dbFetch(fetchImpl: typeof fetch, config: DbAuth, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${config.apiKey}`);
  headers.set('Accept', 'application/json');
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  try {
    return await fetchImpl(`${config.apiUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${config.apiUrl} (${reason})`, 502);
  }
}

function fail(c: Context, status: number, data: unknown, fallback: string): Response {
  return c.json({ message: readErrorMessage(data, fallback) }, statusOf(status));
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
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

function statusOf(status: number): ContentfulStatusCode {
  if (status >= 200 && status <= 599) return status as ContentfulStatusCode;
  return 502;
}
