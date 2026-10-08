import type { Context } from 'hono';
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { createConsoleLinker } from './console-link.js';
import {
  ConfigError,
  normalizeApiUrl,
  parseSetupInput,
  publicSetupStatus,
  deploymentMode,
  resolveConfig,
  writeLinkedConfig,
  type AppConfig,
} from './config.js';
import { mountConversations } from './conversations.js';
import { mountDatabase } from './database.js';
import { mountStorage } from './storage.js';
import { createImageToolResponse } from './image-tool.js';
import { createPreview, readPreview } from './preview.js';
import { cloudApiUrl, parseTicket, redeemTicket, resolveScope, type ProjectScope } from './scope.js';
import { createSession, destroySession, readSession } from './session.js';
import {
  buildChatMessages,
  FALLBACK_MODEL,
  parseModelList,
  pickDefaultModel,
  pickImageModel,
  readErrorMessage,
  readPublicUser,
  readSessionTokens,
  toClientAuthBody,
  type ChatTurn,
} from './vectoree.js';

export type AppDeps = {
  root: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  connectTimeoutMs?: number;
};

const AUTH_PATHS = {
  register: '/api/auth/users',
  login: '/api/auth/sessions',
  verify: '/api/auth/email/verify',
  resend: '/api/auth/email/send-verification',
} as const;

type AuthAction = keyof typeof AUTH_PATHS;

const LINK_ONLY_PATHS = [
  '/api/setup',
  '/api/setup/connect',
  '/api/setup/callback',
  '/api/setup/token',
  '/api/setup/projects',
  '/api/setup/link',
  '/api/settings',
] as const;

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const linker = createConsoleLinker({
    root: deps.root,
    env,
    fetchImpl: deps.fetchImpl,
    openUrl: deps.openUrl,
    timeoutMs: deps.connectTimeoutMs,
  });

  app.onError((error, c) => {
    if (error instanceof ConfigError) {
      return c.json({ message: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    }
    console.error(error instanceof Error ? error.message : error);
    return c.json({ message: 'Server error' }, 500);
  });

  for (const route of LINK_ONLY_PATHS) {
    app.use(route, async (c, next) => {
      if (deploymentMode(env) === 'cloud') return c.json({ message: 'Not available in cloud mode' }, 404);
      await next();
    });
  }

  app.post('/api/preview/redeem', async (c) => {
    if (deploymentMode(env) !== 'cloud') return c.json({ message: 'Not available in local mode' }, 404);
    const ticket = parseTicket(await readJson(c));
    const preview = await redeemTicket(fetchImpl, cloudApiUrl(env), ticket);
    destroySession(c);
    createPreview(c, preview);
    return c.json({
      projectId: preview.projectId,
      ...(preview.organizationId ? { organizationId: preview.organizationId } : {}),
    });
  });

  app.get('/api/setup/status', async (c) => {
    if (deploymentMode(env) === 'cloud') {
      const preview = readPreview(c);
      return c.json({
        linked: false,
        mode: 'cloud',
        previewed: Boolean(preview),
        ...(preview ? { projectId: preview.projectId } : {}),
      });
    }
    const config = resolveConfig(deps.root, env);
    const status = { ...publicSetupStatus(config), mode: deploymentMode(env) };
    if (c.req.query('validate') !== '1') return c.json(status);
    if (!config.linked || !config.apiKey) {
      return c.json({
        linked: false,
        message: 'No project link yet. Use 连接 Vectoree on Setup.',
      });
    }
    const check = await probeModels(config.apiUrl, config.apiKey);
    if (!check.ok) return c.json({ message: check.message }, 400);
    return c.json(status);
  });

  app.get('/api/settings', (c) => {
    const config = requireLinked(c, deps.root, env);
    if (!readSession(c)) return c.json({ message: 'Sign in required' }, 401);
    return c.json({ apiUrl: config.apiUrl, apiKey: config.apiKey });
  });

  app.patch('/api/settings', async (c) => {
    const config = requireLinked(c, deps.root, env);
    if (!readSession(c)) return c.json({ message: 'Sign in required' }, 401);
    const body = await readJson(c);
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const apiUrl = typeof record.apiUrl === 'string' ? normalizeApiUrl(record.apiUrl) : config.apiUrl;
    const apiKey = typeof record.apiKey === 'string' && record.apiKey.trim() ? record.apiKey.trim() : config.apiKey;
    if (!apiKey.startsWith('sk-ve-')) throw new ConfigError('apiKey must be a project key starting with sk-ve-');
    if (!config.projectId) throw new ConfigError('Link a Vectoree project first');
    const check = await probeModels(apiUrl, apiKey);
    if (!check.ok) return c.json({ message: check.message }, 400);
    writeLinkedConfig(
      deps.root,
      { apiUrl, apiKey, projectId: config.projectId, projectName: config.projectName },
      env,
    );
    return c.json({ apiUrl, apiKey });
  });

  app.post('/api/setup', async (c) => {
    const input = parseSetupInput(await readJson(c));
    const check = await probeModels(input.apiUrl, input.apiKey);
    if (!check.ok) return c.json({ message: check.message }, 400);
    writeLinkedConfig(deps.root, input, env);
    const runtime = resolveConfig(deps.root, env);
    return c.json(
      publicSetupStatus({
        linked: true,
        apiUrl: runtime.apiUrl,
        projectId: runtime.projectId ?? input.projectId,
        apiKey: runtime.apiKey,
      }),
    );
  });

  app.post('/api/setup/connect', async (c) => {
    const body = await readJson(c);
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const status = await linker.start({
      apiUrl: typeof record.apiUrl === 'string' ? record.apiUrl : undefined,
      redirectOrigin: typeof record.redirectOrigin === 'string' ? record.redirectOrigin : undefined,
      openBrowser: record.openBrowser === false ? false : undefined,
    });
    return c.json(status);
  });

  app.get('/api/setup/callback', (c) => {
    const result = linker.finishCallback({
      code: c.req.query('code') ?? '',
      state: c.req.query('state') ?? '',
      error: c.req.query('error'),
      errorDescription: c.req.query('error_description'),
    });
    if (result.status === 302) return c.redirect(result.location, 302);
    return c.html(result.html, result.status);
  });

  app.get('/api/setup/connect', (c) => c.json(linker.snapshot()));

  app.post('/api/setup/token', async (c) => c.json(await linker.exchange()));

  app.get('/api/setup/projects', async (c) => c.json({ projects: await linker.listProjects() }));

  app.post('/api/setup/link', async (c) => {
    const body = await readJson(c);
    const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    return c.json(await linker.link(typeof record.projectId === 'string' ? record.projectId : ''));
  });

  app.get('/api/auth/session', (c) => c.json({ user: readSession(c)?.user ?? null }));

  app.get('/api/auth/methods', async (c) => {
    const config = requireLinked(c, deps.root, env);
    const upstream = await vectoreeFetch(fetchImpl, config, '/api/auth/methods', { method: 'GET' });
    const data = await readJsonSafe(upstream);
    if (!upstream.ok) {
      return c.json({ message: readErrorMessage(data, 'Could not load auth methods') }, statusOf(upstream.status));
    }
    return c.json(data ?? { codeLength: 8 });
  });

  app.post('/api/auth/register', (c) => proxyAuth(c, deps, 'register'));
  app.post('/api/auth/login', (c) => proxyAuth(c, deps, 'login'));
  app.post('/api/auth/verify', (c) => proxyAuth(c, deps, 'verify'));
  app.post('/api/auth/resend', (c) => proxyAuth(c, deps, 'resend'));
  app.post('/api/auth/logout', (c) => {
    destroySession(c);
    return c.json({ ok: true });
  });

  app.get('/api/models', async (c) => {
    const config = requireLinked(c, deps.root, env);
    if (!readSession(c)) return c.json({ message: 'Sign in required' }, 401);
    const upstream = await vectoreeFetch(fetchImpl, config, '/api/v1/models', { method: 'GET' });
    const data = await readJsonSafe(upstream);
    if (!upstream.ok) {
      return c.json({ message: readErrorMessage(data, 'Could not list models') }, statusOf(upstream.status));
    }
    const models = parseModelList(data);
    return c.json({ models, defaultModel: pickDefaultModel(models), imageModel: pickImageModel(models) });
  });

  mountConversations(app, { root: deps.root, env, fetchImpl });
  mountDatabase(app, { root: deps.root, env, fetchImpl });
  mountStorage(app, { root: deps.root, env, fetchImpl });

  app.post('/api/chat', async (c) => {
    const config = requireLinked(c, deps.root, env);
    if (!readSession(c)) return c.json({ message: 'Sign in required' }, 401);
    const raw = await c.req.text();
    if (raw.length > 12_000_000) return c.json({ message: 'Request is too large' }, 413);
    let body: unknown;
    try {
      body = raw ? (JSON.parse(raw) as unknown) : null;
    } catch {
      throw new ConfigError('Expected JSON');
    }
    const parsed = parseChatBody(body);
    let messages: ReturnType<typeof buildChatMessages>;
    try {
      messages = buildChatMessages(parsed.messages);
    } catch (error) {
      throw new ConfigError(error instanceof Error ? error.message : 'Invalid image');
    }
    if (parsed.imageTool && !parsed.imageModel) {
      return c.json({ message: 'imageModel is required when imageTool is enabled' }, 400);
    }
    console.log(parsed.imageTool ? 'chat path=image-tool' : 'chat path=database');
    return createImageToolResponse({
      fetchImpl,
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
      model: parsed.model || FALLBACK_MODEL,
      ...(parsed.imageTool && parsed.imageModel ? { imageModel: parsed.imageModel } : {}),
      messages,
    });
  });

  return app;
}

async function proxyAuth(c: Context, deps: AppDeps, action: AuthAction): Promise<Response> {
  const config = requireLinked(c, deps.root, deps.env ?? process.env);
  const upstream = await vectoreeFetch(deps.fetchImpl ?? fetch, config, `${AUTH_PATHS[action]}?client_type=server`, {
    method: 'POST',
    body: JSON.stringify(sanitizeAuthBody(action, await readJson(c))),
  });
  const data = await readJsonSafe(upstream);
  if (action === 'resend') {
    if (!upstream.ok) {
      return c.json({ message: readErrorMessage(data, 'Could not resend the code') }, statusOf(upstream.status));
    }
    return c.json({ ok: true });
  }
  const clientBody = toClientAuthBody(upstream.status, data);
  const tokens = readSessionTokens(data);
  const user = readPublicUser(data);
  const awaitingCode =
    'requireEmailVerification' in clientBody.body && clientBody.body.requireEmailVerification === true;
  if (clientBody.httpStatus === 200 && tokens && user && !awaitingCode) {
    createSession(c, {
      user,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(config.previewId ? { previewId: config.previewId } : {}),
    });
  }
  return c.json(clientBody.body, statusOf(clientBody.httpStatus));
}

function sanitizeAuthBody(action: AuthAction, body: unknown): Record<string, string> {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const email = typeof record.email === 'string' ? record.email.trim() : '';
  if (!email) throw new ConfigError('email is required');
  if (action === 'verify') {
    const otp = typeof record.otp === 'string' ? record.otp.trim() : '';
    if (!/^\d{8}$/.test(otp)) throw new ConfigError('otp must be 8 digits');
    return { email, otp };
  }
  if (action === 'resend') return { email };
  const password = typeof record.password === 'string' ? record.password : '';
  if (!password) throw new ConfigError('password is required');
  const payload: Record<string, string> = { email, password };
  if (action === 'register' && typeof record.name === 'string' && record.name.trim()) {
    payload.name = record.name.trim();
  }
  return payload;
}

function parseChatBody(body: unknown): {
  model?: string;
  imageTool: boolean;
  imageModel?: string;
  messages: ChatTurn[];
} {
  if (!body || typeof body !== 'object') throw new ConfigError('Expected a JSON object');
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    throw new ConfigError('messages is required');
  }
  if (record.messages.length > 40) throw new ConfigError('Too many messages');
  const messages: ChatTurn[] = record.messages.map((item) => {
    if (!item || typeof item !== 'object') throw new ConfigError('Invalid message');
    const turn = item as Record<string, unknown>;
    if (turn.role !== 'system' && turn.role !== 'user' && turn.role !== 'assistant') {
      throw new ConfigError('Invalid message role');
    }
    const content = typeof turn.content === 'string' ? turn.content.slice(0, 16_000) : '';
    const imageRecord =
      turn.image && typeof turn.image === 'object' ? (turn.image as Record<string, unknown>) : null;
    const image = imageRecord
      ? { mediaType: String(imageRecord.mediaType ?? ''), data: String(imageRecord.data ?? '') }
      : undefined;
    if (!content.trim() && !image) throw new ConfigError('Message is empty');
    if (image && turn.role !== 'user') throw new ConfigError('Only user messages can include an image');
    return { role: turn.role, content, ...(image ? { image } : {}) };
  });
  const model = typeof record.model === 'string' && record.model.trim() ? record.model.trim() : undefined;
  const imageModel =
    typeof record.imageModel === 'string' && record.imageModel.trim() ? record.imageModel.trim() : undefined;
  return { model, imageTool: record.imageTool === true, imageModel, messages };
}

async function probeModels(apiUrl: string, apiKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
  let check: Response;
  try {
    check = await fetch(`${apiUrl}/api/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    return { ok: false, message: `Could not reach Vectoree at ${apiUrl} (${reason})` };
  }
  if (!check.ok) {
    const data = await readJsonSafe(check);
    return { ok: false, message: readErrorMessage(data, `Vectoree rejected the key (${check.status})`) };
  }
  return { ok: true };
}

function requireLinked(c: Context, root: string, env: NodeJS.ProcessEnv): ProjectScope {
  return resolveScope(c, root, env);
}

async function vectoreeFetch(
  fetchImpl: typeof fetch,
  config: AppConfig & { apiKey: string },
  path: string,
  init: RequestInit,
) {
  try {
    return await fetchImpl(`${config.apiUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${config.apiUrl} (${reason})`, 502);
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

function statusOf(status: number): ContentfulStatusCode {
  if (status >= 200 && status <= 599) return status as ContentfulStatusCode;
  return 502;
}
