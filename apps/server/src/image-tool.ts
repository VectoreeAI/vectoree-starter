import { randomUUID } from 'node:crypto';
import { executeDatabaseTool, type DbMutation } from './database.js';
import { executeStorageTool, type StorageMutation } from './storage.js';
import { readErrorMessage } from './vectoree.js';

export const GENERATE_IMAGE_TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description:
      'Generate an image from a text prompt. Use when the user asks to draw, generate, or create an image.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Detailed image prompt' },
        n: { type: 'integer', minimum: 1, maximum: 4 },
        size: { type: 'string', description: 'e.g. 1024x1024' },
      },
      required: ['prompt'],
    },
  },
} as const;

export type GeneratedImage = { url: string };

type ToolCall = { id: string; name: string; arguments: string };

const MAX_TOOL_ROUNDS = 8;
const FOLLOW_UP_TIMEOUT_MS = 30_000;
const DATABASE_SYSTEM =
  'You have database tools (list_tables, get_table_schema, create_table, list_records, insert_records, update_record, delete_record). When the user asks to create, list, query, insert, update, or delete tables or rows, you MUST call those tools. Never claim you can only draw images. tableName and columnName must be ASCII identifiers (letters, digits, underscore), for example demo and title. Never use Chinese names. If the user does not name the table, use demo. create_table columns use columnName, type, isNullable, and isUnique — never name, nullable, unique, or type file. Example: {"tableName":"demo","columns":[{"columnName":"title","type":"string","isNullable":false,"isUnique":false}],"rlsEnabled":true}. Do not send id, created_at, or updated_at; the backend adds them.';
const IMAGE_TOOL_SYSTEM =
  'You also have a generate_image tool. Use it only for pictures. When the user asks to draw or generate an image, you MUST call generate_image. Never claim you lack image tools.';
const IMAGE_INTENT = /draw|generate|image|画|生图|生成.*图/i;
const STORAGE_SYSTEM =
  'You also have storage tools (list_buckets, create_bucket, delete_bucket, list_objects, upload_object, delete_object, get_object_info). When the user asks about buckets, files, object storage, uploads, or deletes, you MUST call those tools. bucketName is ASCII only (letters, digits, underscore, hyphen); use demo if the name is vague. Object keys may contain /. Do not claim you can only draw images or only touch the database.';
const DATABASE_INTENT = /表|建表|字段|数据库|demo表|records|schema|create table|delete row/i;
const STORAGE_INTENT = /桶|存储|对象存储|上传.*文件|删除.*文件|bucket|storage|upload|object key/i;
const STORAGE_CLEAR = /桶|存储|bucket|storage|上传.*文件|删除.*文件/;
const DATABASE_CLEAR = /表|字段|records|schema|建表/;
const STORAGE_TOOL_NAMES = new Set([
  'list_buckets',
  'create_bucket',
  'delete_bucket',
  'list_objects',
  'upload_object',
  'delete_object',
  'get_object_info',
]);
const FORCED_IMAGE_TOOL = { type: 'function', function: { name: 'generate_image' } } as const;

const DATABASE_TOOLS = [
  tool('list_tables', 'List database table names in the linked project.', {}),
  tool('get_table_schema', 'Get columns for one table.', { table: { type: 'string' } }, ['table']),
  tool(
    'create_table',
    'Create a database table. tableName and columnName must match ^[A-Za-z_][A-Za-z0-9_]*$ (e.g. demo, title). No Chinese names. If the user is vague, use tableName demo. Do not include id, created_at, or updated_at; the backend adds them. Include at least one other column. Each column requires columnName, type, isNullable, and isUnique (not name, nullable, or unique). Optional defaultValue. Types: string, date, datetime, integer, float, boolean, uuid, json. Example: {"tableName":"demo","columns":[{"columnName":"title","type":"string","isNullable":false,"isUnique":false}],"rlsEnabled":true}',
    {
      tableName: {
        type: 'string',
        description: 'ASCII identifier such as demo. No Chinese. Use demo when the user does not specify a name.',
      },
      columns: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            columnName: { type: 'string', description: 'ASCII identifier such as title. No Chinese names.' },
            type: {
              type: 'string',
              enum: ['string', 'date', 'datetime', 'integer', 'float', 'boolean', 'uuid', 'json'],
            },
            isNullable: { type: 'boolean' },
            isUnique: { type: 'boolean' },
            defaultValue: { type: 'string' },
          },
          required: ['columnName', 'type', 'isNullable', 'isUnique'],
        },
      },
      rlsEnabled: { type: 'boolean' },
    },
    ['tableName', 'columns'],
  ),
  tool(
    'list_records',
    'List rows in a table.',
    {
      table: { type: 'string' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      order: { type: 'string', description: 'e.g. createdAt.desc' },
    },
    ['table'],
  ),
  tool(
    'insert_records',
    'Insert one or more rows. records must be an array of objects.',
    { table: { type: 'string' }, records: { type: 'array', items: { type: 'object' } } },
    ['table', 'records'],
  ),
  tool(
    'update_record',
    'Update one row by id.',
    { table: { type: 'string' }, id: { type: 'string' }, values: { type: 'object' } },
    ['table', 'id', 'values'],
  ),
  tool('delete_record', 'Delete one row by id.', { table: { type: 'string' }, id: { type: 'string' } }, ['table', 'id']),
] as const;

const STORAGE_TOOLS = [
  tool('list_buckets', 'List object-storage buckets.', {}),
  tool(
    'create_bucket',
    'Create a bucket. bucketName must match ^[a-zA-Z0-9_-]+$. If the user is vague, use demo.',
    {
      bucketName: { type: 'string', description: 'ASCII name such as demo.' },
      isPublic: { type: 'boolean' },
    },
    ['bucketName'],
  ),
  tool('delete_bucket', 'Delete a bucket and its objects.', { bucketName: { type: 'string' } }, ['bucketName']),
  tool(
    'list_objects',
    'List objects in a bucket.',
    {
      bucket: { type: 'string' },
      prefix: { type: 'string' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
      search: { type: 'string' },
    },
    ['bucket'],
  ),
  tool(
    'upload_object',
    'Upload an object. Provide textContent, contentBase64, or an http(s) sourceUrl. key may contain /. Default key for text is notes/hello.txt.',
    {
      bucket: { type: 'string' },
      key: { type: 'string' },
      textContent: { type: 'string' },
      contentBase64: { type: 'string' },
      sourceUrl: { type: 'string' },
      contentType: { type: 'string' },
    },
    ['bucket'],
  ),
  tool('delete_object', 'Delete one object by key.', { bucket: { type: 'string' }, key: { type: 'string' } }, ['bucket', 'key']),
  tool('get_object_info', 'Look up one object and its URL.', { bucket: { type: 'string' }, key: { type: 'string' } }, ['bucket', 'key']),
] as const;

type ToolChoice = 'auto' | 'required' | typeof FORCED_IMAGE_TOOL;

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
) {
  return {
    type: 'function' as const,
    function: {
      name,
      description,
      parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) },
    },
  };
}

export async function createImageToolResponse(input: {
  fetchImpl: typeof fetch;
  apiUrl: string;
  apiKey: string;
  model: string;
  imageModel?: string;
  messages: Array<Record<string, unknown>>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}): Promise<Response> {
  const imageEnabled = Boolean(input.imageModel);
  const encoder = new TextEncoder();
  const messages = [
    {
      role: 'system',
      content: [DATABASE_SYSTEM, STORAGE_SYSTEM, imageEnabled ? IMAGE_TOOL_SYSTEM : ''].filter(Boolean).join(' '),
    },
    ...input.messages.map((message) => ({ ...message })),
  ];
  const intent = userIntent(messages);
  let started = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const send = (chunk: string) => {
    if (!started) return;
    controller.enqueue(encoder.encode(chunk));
  };
  const emitText = (text: string) => {
    if (!text) return;
    send(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
  };
  const emitImages = (images: GeneratedImage[]) => {
    if (images.length === 0) return;
    send(`event: starter.images\ndata: ${JSON.stringify({ images })}\n\n`);
  };
  const emitImageStatus = (payload: { status: 'generating' | 'error'; n?: number }) => {
    send(`event: starter.image_status\ndata: ${JSON.stringify(payload)}\n\n`);
  };
  const emitDatabase = (mutation: DbMutation) => {
    send(`event: starter.database\ndata: ${JSON.stringify(mutation)}\n\n`);
  };
  const emitStorage = (mutation: StorageMutation) => {
    send(`event: starter.storage\ndata: ${JSON.stringify(mutation)}\n\n`);
  };
  const finish = (streamController: ReadableStreamDefaultController<Uint8Array>) => {
    send('data: [DONE]\n\n');
    streamController.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(streamController) {
      controller = streamController;
      started = true;
      try {
        let turn = await completeChat(input, messages, 'auto', imageEnabled);
        if (turn.toolCalls.length === 0 && intent === 'image' && imageEnabled) {
          turn = await completeChat(input, messages, FORCED_IMAGE_TOOL, imageEnabled);
        } else if (turn.toolCalls.length === 0 && (intent === 'database' || intent === 'storage')) {
          turn = await completeChat(input, messages, 'required', imageEnabled);
        }
        let dbSuccess = false;
        let lastDbFailed = false;
        let storageSuccess = false;
        let lastStorageFailed = false;
        let nextChoice: ToolChoice = 'auto';
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
          if (round > 0) {
            try {
              turn = await completeChat(input, messages, nextChoice, imageEnabled, FOLLOW_UP_TIMEOUT_MS);
            } catch {
              finish(streamController);
              return;
            }
            nextChoice = 'auto';
          }
          if (turn.toolCalls.length === 0) {
            const unfinished =
              intent === 'storage'
                ? domainUnfinished(intent, storageSuccess, lastStorageFailed, round)
                : domainUnfinished(intent, dbSuccess, lastDbFailed, round);
            if (unfinished) {
              messages.push({
                role: 'user',
                content:
                  intent === 'storage'
                    ? 'The storage task is not finished. Call a storage tool now. bucketName must be an ASCII identifier such as demo. Do not reply with text only.'
                    : 'The database task is not finished. Call a tool now. tableName and columnName must be ASCII identifiers such as demo and title. Do not reply with text only.',
              });
              nextChoice = 'required';
              continue;
            }
            emitText(turn.content);
            finish(streamController);
            return;
          }
          emitText(turn.content);
          messages.push(assistantToolMessage(turn));
          let emittedImages = false;
          let ranSideTool = false;
          for (const call of turn.toolCalls) {
            if (call.name === 'generate_image') {
              emitImageStatus({ status: 'generating', n: toolImageCount(call) });
              const result = imageEnabled
                ? await runGenerateImage({ ...input, imageModel: input.imageModel ?? '' }, call)
                : { error: 'Image tool is off' };
              if ('images' in result) {
                emitImages(result.images);
                emittedImages = true;
              } else {
                emitText(`Image tool error: ${result.error}`);
                emitImageStatus({ status: 'error' });
              }
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
              continue;
            }
            ranSideTool = true;
            const args = parseToolArgs(call.arguments);
            const storageCall = STORAGE_TOOL_NAMES.has(call.name);
            if ('error' in args) {
              if (storageCall) lastStorageFailed = true;
              else lastDbFailed = true;
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: args.error }) });
              continue;
            }
            if (storageCall) {
              const outcome = await executeStorageTool(
                input.fetchImpl,
                { apiUrl: input.apiUrl, apiKey: input.apiKey },
                call.name,
                args,
              );
              if (isToolError(outcome.result)) lastStorageFailed = true;
              else {
                lastStorageFailed = false;
                storageSuccess = true;
              }
              if (outcome.mutation) emitStorage(outcome.mutation);
              messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) });
              continue;
            }
            const outcome = await executeDatabaseTool(
              input.fetchImpl,
              { apiUrl: input.apiUrl, apiKey: input.apiKey },
              call.name,
              args,
            );
            if (isToolError(outcome.result)) lastDbFailed = true;
            else {
              lastDbFailed = false;
              dbSuccess = true;
            }
            if (outcome.mutation) emitDatabase(outcome.mutation);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(outcome.result) });
          }
          if (emittedImages && !ranSideTool) {
            finish(streamController);
            return;
          }
        }
        finish(streamController);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Chat failed';
        emitText(message);
        finish(streamController);
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}

function domainUnfinished(
  intent: 'database' | 'storage' | 'image' | 'none',
  success: boolean,
  lastFailed: boolean,
  round: number,
): boolean {
  if ((intent !== 'database' && intent !== 'storage') || round >= MAX_TOOL_ROUNDS - 1) return false;
  return !success || lastFailed;
}

function isToolError(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && typeof (result as { error?: unknown }).error === 'string');
}

function userIntent(messages: Array<Record<string, unknown>>): 'database' | 'storage' | 'image' | 'none' {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const text = messageText(messages[index] ?? {});
    const storage = STORAGE_INTENT.test(text);
    const database = DATABASE_INTENT.test(text);
    if (storage && database) {
      const storageClear = STORAGE_CLEAR.test(text);
      const databaseClear = DATABASE_CLEAR.test(text);
      if (storageClear && !databaseClear) return 'storage';
      if (databaseClear) return 'database';
      return 'storage';
    }
    if (storage) return 'storage';
    if (database) return 'database';
    if (IMAGE_INTENT.test(text)) return 'image';
    return 'none';
  }
  return 'none';
}

function parseToolArgs(raw: string): Record<string, unknown> | { error: string } {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Invalid tool arguments' };
    return parsed as Record<string, unknown>;
  } catch {
    return { error: 'Invalid tool arguments' };
  }
}

function messageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join(' ');
}

async function completeChat(
  input: {
    fetchImpl: typeof fetch;
    apiUrl: string;
    apiKey: string;
    model: string;
  },
  messages: Array<Record<string, unknown>>,
  toolChoice: ToolChoice,
  imageEnabled: boolean,
  timeoutMs = 120_000,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const tools = imageEnabled
    ? [GENERATE_IMAGE_TOOL, ...DATABASE_TOOLS, ...STORAGE_TOOLS]
    : [...DATABASE_TOOLS, ...STORAGE_TOOLS];
  const response = await input.fetchImpl(`${input.apiUrl}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    },
    body: JSON.stringify({
      model: input.model,
      messages,
      stream: true,
      tool_choice: toolChoice,
      tools,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(readErrorMessage(data, `Chat failed (${response.status})`));
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/event-stream') && response.body) {
    return readChatSse(response.body);
  }
  return readChatJson(await response.json().catch(() => null));
}

function assistantToolMessage(turn: { content: string; toolCalls: ToolCall[] }): Record<string, unknown> {
  return {
    role: 'assistant',
    content: turn.content || null,
    tool_calls: turn.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

async function runGenerateImage(
  input: {
    fetchImpl: typeof fetch;
    apiUrl: string;
    apiKey: string;
    imageModel: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
  },
  call: ToolCall,
): Promise<{ images: GeneratedImage[] } | { error: string }> {
  if (call.name !== 'generate_image') return { error: `Unsupported tool ${call.name}` };
  let args: Record<string, unknown>;
  try {
    const parsed = JSON.parse(call.arguments || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: 'Invalid tool arguments' };
    args = parsed as Record<string, unknown>;
  } catch {
    return { error: 'Invalid tool arguments' };
  }
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  if (!prompt) return { error: 'prompt is required' };
  const body: Record<string, unknown> = { model: input.imageModel, prompt, async: true };
  if (typeof args.n === 'number' || (typeof args.n === 'string' && args.n.trim())) body.n = clampCount(args.n);
  if (typeof args.size === 'string' && args.size.trim()) body.size = args.size.trim();
  const idempotencyKey = randomUUID();
  try {
    let response = await postImages(input, body, idempotencyKey);
    if (response.status === 502 || response.status === 504) {
      const hinted = response.headers.get('x-vectoree-image-job-id');
      if (hinted) return pollImageJob(input, { id: hinted });
      response = await postImages(input, body, idempotencyKey);
    }
    const hinted = response.headers.get('x-vectoree-image-job-id');
    const data = await response.json().catch(() => null);
    if (response.status === 202 || isPendingJob(data)) {
      return pollImageJob(input, data ?? (hinted ? { id: hinted } : null));
    }
    if ((response.status === 502 || response.status === 504) && hinted) {
      return pollImageJob(input, { id: hinted });
    }
    if (response.ok) {
      const images = normalizeGeneratedImages(data);
      if (images.length > 0) return { images };
    }
    if (!response.ok) return { error: readErrorMessage(data, `Image generation failed (${response.status})`) };
    return { error: 'Image provider returned no image data' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Image generation failed' };
  }
}

async function postImages(
  input: { fetchImpl: typeof fetch; apiUrl: string; apiKey: string },
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<Response> {
  return input.fetchImpl(`${input.apiUrl}/api/v1/images`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Prefer: 'respond-async',
      'Idempotency-Key': idempotencyKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}

async function pollImageJob(
  input: {
    fetchImpl: typeof fetch;
    apiUrl: string;
    apiKey: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
  },
  first: unknown,
): Promise<{ images: GeneratedImage[] } | { error: string }> {
  const jobId = readJobId(first);
  if (!jobId) return { error: 'Image job did not include an id' };
  const timeoutMs = input.pollTimeoutMs ?? 300_000;
  let wait = input.pollIntervalMs ?? 400;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    wait = Math.min(Math.max(wait, 1) * 2, 4_000);
    const response = await input.fetchImpl(`${input.apiUrl}/api/v1/images/jobs/${encodeURIComponent(jobId)}`, {
      headers: { Authorization: `Bearer ${input.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return { error: readErrorMessage(data, `Image job failed (${response.status})`) };
    const status = readStatus(data);
    if (status === 'failed') return { error: readErrorMessage(data, 'Image generation failed') };
    const images = normalizeGeneratedImages(data);
    if (status === 'completed' || (status === '' && images.length > 0)) {
      if (images.length === 0) return { error: 'Image provider returned no image data' };
      return { images };
    }
  }
  return { error: 'Image generation timed out' };
}

export function normalizeGeneratedImages(payload: unknown): GeneratedImage[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const images: GeneratedImage[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const image = item as Record<string, unknown>;
    if (typeof image.url === 'string' && image.url.trim()) {
      images.push({ url: image.url.trim() });
      continue;
    }
    if (typeof image.b64_json === 'string' && image.b64_json.trim()) {
      const mediaType = typeof image.media_type === 'string' && image.media_type.trim() ? image.media_type.trim() : 'image/png';
      images.push({ url: `data:${mediaType};base64,${image.b64_json.trim()}` });
    }
  }
  return images;
}

function isPendingJob(payload: unknown): boolean {
  const status = readStatus(payload);
  return status === 'pending';
}

function readStatus(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const status = (payload as { status?: unknown }).status;
  return typeof status === 'string' ? status.toLowerCase() : '';
}

function readJobId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as { id?: unknown; polling_url?: unknown };
  if (typeof record.id === 'string' && record.id.trim()) return record.id.trim();
  if (typeof record.polling_url === 'string') {
    const match = /\/images\/jobs\/([^/?#]+)/.exec(record.polling_url);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }
  return null;
}

function toolImageCount(call: ToolCall): number {
  try {
    const parsed = JSON.parse(call.arguments || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 1;
    const count = (parsed as { n?: unknown }).n;
    if (typeof count === 'number' || (typeof count === 'string' && count.trim())) return clampCount(count);
  } catch {
    // Missing or invalid n uses one tile.
  }
  return 1;
}

function clampCount(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 1;
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, Math.floor(n)));
}

async function readChatSse(body: ReadableStream<Uint8Array>): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const consume = (block: string) => {
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json: unknown;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      const choice = firstChoice(json);
      if (!choice) continue;
      const delta = choice.delta ?? choice.message;
      if (!delta || typeof delta !== 'object') continue;
      const text = (delta as { content?: unknown }).content;
      if (typeof text === 'string') content += text;
      const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const item of toolCalls) {
        if (!item || typeof item !== 'object') continue;
        const call = item as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const index = typeof call.index === 'number' ? call.index : calls.size;
        const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call.id === 'string' && call.id) current.id = call.id;
        if (typeof call.function?.name === 'string' && call.function.name) current.name = call.function.name;
        if (typeof call.function?.arguments === 'string') current.arguments += call.function.arguments;
        calls.set(index, current);
      }
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split = buffer.search(/\r?\n\r?\n/);
    while (split >= 0) {
      const sep = buffer.startsWith('\r\n', split) ? 4 : 2;
      consume(buffer.slice(0, split));
      buffer = buffer.slice(split + sep);
      split = buffer.search(/\r?\n\r?\n/);
    }
  }
  if (buffer.trim()) consume(buffer);
  return { content, toolCalls: finishCalls(calls) };
}

function readChatJson(payload: unknown): { content: string; toolCalls: ToolCall[] } {
  const choice = firstChoice(payload);
  const message = choice?.message;
  if (!message || typeof message !== 'object') return { content: '', toolCalls: [] };
  const content = typeof (message as { content?: unknown }).content === 'string' ? (message as { content: string }).content : '';
  const raw = (message as { tool_calls?: unknown }).tool_calls;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (!item || typeof item !== 'object') return;
      const call = item as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
      calls.set(index, {
        id: typeof call.id === 'string' ? call.id : `call_${index}`,
        name: typeof call.function?.name === 'string' ? call.function.name : '',
        arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '',
      });
    });
  }
  return { content, toolCalls: finishCalls(calls) };
}

function finishCalls(calls: Map<number, { id: string; name: string; arguments: string }>): ToolCall[] {
  return [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call], index) => ({
      id: call.id || `call_${index}`,
      name: call.name,
      arguments: call.arguments,
    }))
    .filter((call) => call.name);
}

function firstChoice(payload: unknown): { delta?: unknown; message?: unknown } | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') return null;
  return choices[0] as { delta?: unknown; message?: unknown };
}
