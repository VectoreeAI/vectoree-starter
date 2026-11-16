import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigError, normalizeApiUrl, writeLinkedConfig } from './config.js';
import { readErrorMessage } from './vectoree.js';

const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const KEY_SCOPES = ['gateway:chat', 'gateway:models', 'tools:*', 'database:*', 'storage:*', 'auth:*'];

export type ConnectPublic = {
  status: 'idle' | 'pending' | 'device' | 'callback' | 'authorized' | 'linked' | 'error';
  authorizeUrl?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  message?: string;
  apiUrl?: string;
  projectId?: string;
  projectName?: string;
};

export type ConsoleProject = { id: string; name: string; organizationId?: string; organizationName?: string };

export type ConsoleLinkerOptions = {
  root: string;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  openUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
};

type PendingLogin = {
  state: string;
  verifier: string;
  apiUrl: string;
  redirectUri: string;
  appUrl: string;
  expiresAt: number;
  code?: string;
};

type PendingDevice = {
  deviceCode: string;
  apiUrl: string;
  userCode: string;
  verificationUri: string;
  intervalSeconds: number;
  expiresAt: number;
};

type ConsoleSession = { apiUrl: string; accessToken: string; refreshToken?: string };

function consoleSessionFile(root: string): string {
  return path.join(root, '.vectoree', 'console-session.json');
}

function writeConsoleSession(root: string, session: ConsoleSession): void {
  const dir = path.join(root, '.vectoree');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = consoleSessionFile(root);
  const tmp = path.join(dir, `.console-session.json.${process.pid}.tmp`);
  const body = {
    apiUrl: session.apiUrl,
    accessToken: session.accessToken,
    ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
  };
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod can fail on some filesystems; the file is still written.
  }
}

function readConsoleSession(root: string): ConsoleSession | null {
  try {
    const record = JSON.parse(fs.readFileSync(consoleSessionFile(root), 'utf8')) as Record<string, unknown>;
    const apiUrl = text(record.apiUrl);
    const accessToken = text(record.accessToken);
    if (!apiUrl || !accessToken) return null;
    const refreshToken = text(record.refreshToken);
    return { apiUrl, accessToken, ...(refreshToken ? { refreshToken } : {}) };
  } catch {
    return null;
  }
}

function clearConsoleSession(root: string): void {
  try {
    fs.rmSync(consoleSessionFile(root), { force: true });
  } catch {
    // The login can continue without deleting a file that is already gone.
  }
}

export function createConsoleLinker(options: ConsoleLinkerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const openUrl = options.openUrl ?? openSystemBrowser;
  const timeoutMs = options.timeoutMs ?? 180_000;
  let state: ConnectPublic = { status: 'idle' };
  let login: PendingLogin | null = null;
  let device: PendingDevice | null = null;
  let session: ConsoleSession | null = null;
  let projects: ConsoleProject[] = [];
  let exchanging: Promise<ConnectPublic> | null = null;
  let polling: Promise<ConnectPublic> | null = null;
  let linking: Promise<ConnectPublic> | null = null;

  return {
    snapshot(): ConnectPublic {
      if (state.status === 'pending' && login && Date.now() > login.expiresAt) {
        login = null;
        state = { status: 'error', apiUrl: state.apiUrl, message: 'Console login timed out. Log in again.' };
      }
      if (state.status === 'device' && device && Date.now() > device.expiresAt) {
        device = null;
        state = { status: 'error', apiUrl: state.apiUrl, message: 'Console login timed out. Log in again.' };
      }
      return publicConnect(state);
    },

    async start(input: { apiUrl?: string; openBrowser?: boolean; redirectOrigin?: string }): Promise<ConnectPublic> {
      const apiUrl = normalizeApiUrl(input.apiUrl?.trim() || 'https://vectoree.ai');
      const redirectUri = callbackUriFromOrigin(input.redirectOrigin) ?? 'http://127.0.0.1:5173/api/setup/callback';
      device = null;
      forgetSession();
      const { verifier, challenge } = pkcePair();
      const stateValue = randomBytes(16).toString('hex');
      login = {
        state: stateValue,
        verifier,
        apiUrl,
        redirectUri,
        appUrl: appUrlFromCallback(redirectUri),
        expiresAt: Date.now() + timeoutMs,
      };
      projects = [];
      const authorize = new URL(`${apiUrl}/api/system/auth/cli/authorize`);
      authorize.searchParams.set('response_type', 'code');
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('state', stateValue);
      const authorizeUrl = authorize.toString();
      state = { status: 'pending', authorizeUrl, apiUrl };
      if (input.openBrowser !== false) await openUrl(authorizeUrl).catch(() => undefined);
      return { ...state };
    },

    finishCallback(query: {
      code: string;
      state: string;
      error?: string;
      errorDescription?: string;
    }): { status: 302; location: string } | { status: 400; html: string } {
      const current = login;
      if (!current || query.state !== current.state || current.code) {
        return { status: 400, html: '<p>Invalid Vectoree login callback.</p>' };
      }
      if (query.error || !query.code || Date.now() > current.expiresAt) {
        login = null;
        const message = query.error
          ? query.errorDescription || `Console login failed (${query.error})`
          : !query.code
            ? 'Console login did not return a code'
            : 'Console login timed out. Log in again.';
        state = { status: 'error', apiUrl: current.apiUrl, message };
        return { status: 302, location: current.appUrl };
      }
      current.code = query.code;
      state = { status: 'callback', apiUrl: current.apiUrl };
      return { status: 302, location: current.appUrl };
    },

    pollDevice(): Promise<ConnectPublic> {
      if (polling) return polling;
      const current = device;
      if (!current || state.status !== 'device') {
        return Promise.reject(new ConfigError('No Console login to finish. Log in again.', 409));
      }
      if (Date.now() > current.expiresAt) {
        device = null;
        state = { status: 'error', apiUrl: current.apiUrl, message: 'Console login timed out. Log in again.' };
        return Promise.resolve(publicConnect(state));
      }
      polling = (async () => {
        try {
          const response = await fetchImpl(`${current.apiUrl}/api/system/auth/cli/device/token`, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: current.deviceCode }),
          });
          const data = await readBody(response);
          const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
          const errorCode = text(record.error);
          if (response.status === 400 && (errorCode === 'authorization_pending' || errorCode === 'slow_down')) {
            return publicConnect(state);
          }
          if (!response.ok || typeof record.accessToken !== 'string' || !record.accessToken) {
            device = null;
            const message = !response.ok
              ? text(record.error_description) || readErrorMessage(data, `Console login failed (${response.status})`)
              : 'Console login did not return a session';
            state = { status: 'error', apiUrl: current.apiUrl, message };
            throw new ConfigError(message, 502);
          }
          rememberSession({
            apiUrl: current.apiUrl,
            accessToken: record.accessToken,
            refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
          });
          device = null;
          state = { status: 'authorized', apiUrl: current.apiUrl };
          return publicConnect(state);
        } catch (error) {
          if (error instanceof ConfigError) throw error;
          throw new ConfigError(error instanceof Error ? error.message : 'Console login failed', 502);
        } finally {
          polling = null;
        }
      })();
      return polling;
    },

    exchange(): Promise<ConnectPublic> {
      if (exchanging) return exchanging;
      if (state.status === 'authorized' && session) return Promise.resolve({ ...state });
      const current = login;
      if (!current?.code) {
        return Promise.reject(new ConfigError('No Console login to finish. Log in again.', 409));
      }
      const code = current.code;
      exchanging = (async () => {
        try {
          rememberSession({
            apiUrl: current.apiUrl,
            ...(await exchangeCode(fetchImpl, current.apiUrl, {
              code,
              codeVerifier: current.verifier,
              redirectUri: current.redirectUri,
            })),
          });
          state = { status: 'authorized', apiUrl: current.apiUrl };
          return { ...state };
        } catch (error) {
          forgetSession();
          const message = error instanceof Error ? error.message : 'Console login failed';
          state = { status: 'error', apiUrl: current.apiUrl, message };
          throw new ConfigError(message, 502);
        } finally {
          if (login === current) login = null;
          exchanging = null;
        }
      })();
      return exchanging;
    },

    async listProjects(): Promise<ConsoleProject[]> {
      const current = requireSession();
      try {
        const [list, organizations] = await Promise.all([
          fetchProjects(fetchImpl, current.apiUrl, current.accessToken),
          fetchOrganizations(fetchImpl, current.apiUrl, current.accessToken),
        ]);
        projects = list.map((item) => {
          const name = item.organizationId ? organizations.get(item.organizationId) : undefined;
          return name && !item.organizationName ? { ...item, organizationName: name } : item;
        });
      } catch (error) {
        if (error instanceof ConfigError && error.status === 401) expireSession(error.message);
        throw error;
      }
      return projects.map((item) => ({ ...item }));
    },

    async turnstileSiteKey(): Promise<{ siteKey: string | null }> {
      const current = requireSession();
      let response: Response;
      try {
        response = await fetchImpl(`${current.apiUrl}/api/system/auth/public-config`, {
          headers: { Accept: 'application/json' },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'network error';
        throw new ConfigError(`Could not reach Vectoree at ${current.apiUrl} (${reason})`, 502);
      }
      const data = await readBody(response);
      if (!response.ok) {
        throw new ConfigError(readErrorMessage(data, `Could not load human verification (${response.status})`), 502);
      }
      const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      const siteKey = text(record.turnstileSiteKey);
      return { siteKey: siteKey || null };
    },

    link(projectId: string, turnstileToken?: string): Promise<ConnectPublic> {
      if (linking) return linking;
      const id = projectId.trim();
      if (!PROJECT_UUID.test(id)) {
        return Promise.reject(new ConfigError('projectId must be a UUID from the Vectoree console'));
      }
      let current: ConsoleSession;
      try {
        current = requireSession();
      } catch (error) {
        return Promise.reject(error);
      }
      linking = (async () => {
        try {
          let match = projects.find((item) => item.id === id);
          if (!match) {
            projects = await fetchProjects(fetchImpl, current.apiUrl, current.accessToken);
            match = projects.find((item) => item.id === id);
          }
          if (!match) throw new ConfigError('That project was not found on this Vectoree account');
          const minted = await mintProjectKey(fetchImpl, current.apiUrl, current.accessToken, {
            projectId: id,
            projectName: match.name,
            root: options.root,
            turnstileToken,
          });
          writeLinkedConfig(
            options.root,
            {
              apiUrl: current.apiUrl,
              accessToken: current.accessToken,
              refreshToken: current.refreshToken,
              apiKey: minted.apiKey,
              projectId: id,
              projectName: match.name,
              keyId: minted.keyId,
            },
            options.env,
          );
          forgetSession();
          projects = [];
          state = { status: 'linked', apiUrl: current.apiUrl, projectId: id, projectName: match.name };
          return { ...state };
        } catch (error) {
          if (error instanceof ConfigError) {
            if (error.status === 401) expireSession(error.message);
            throw error;
          }
          throw new ConfigError(error instanceof Error ? error.message : 'Could not link the project', 502);
        } finally {
          linking = null;
        }
      })();
      return linking;
    },
  };

  async function startDevice(apiUrl: string): Promise<ConnectPublic> {
    login = null;
    forgetSession();
    projects = [];
    let response: Response;
    try {
      response = await fetchImpl(`${apiUrl}/api/system/auth/cli/device/code`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'network error';
      const message = `Could not reach Vectoree at ${apiUrl} (${reason})`;
      device = null;
      state = { status: 'error', apiUrl, message };
      throw new ConfigError(message, 502);
    }
    const data = await readBody(response);
    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const deviceCode = text(record.device_code);
    const userCode = text(record.user_code);
    const verificationUri = text(record.verification_uri_complete) || text(record.verification_uri);
    if (!response.ok || !deviceCode || !userCode || !verificationUri) {
      device = null;
      const message = readErrorMessage(data, 'Console login did not return a device code');
      state = { status: 'error', apiUrl, message };
      throw new ConfigError(message, 502);
    }
    const expiresIn = typeof record.expires_in === 'number' && record.expires_in > 0 ? record.expires_in : 900;
    const intervalSeconds = typeof record.interval === 'number' && record.interval >= 1 ? Math.ceil(record.interval) : 2;
    device = {
      deviceCode,
      apiUrl,
      userCode,
      verificationUri,
      intervalSeconds,
      expiresAt: Date.now() + expiresIn * 1000,
    };
    state = { status: 'device', apiUrl, userCode, verificationUri, intervalSeconds };
    return publicConnect(state);
  }

  function rememberSession(next: ConsoleSession) {
    session = next;
    writeConsoleSession(options.root, next);
  }

  function forgetSession() {
    session = null;
    clearConsoleSession(options.root);
  }

  function requireSession(): ConsoleSession {
    if (!session) {
      const stored = readConsoleSession(options.root);
      if (stored) session = stored;
    }
    if (!session) throw new ConfigError('Log in to Vectoree first', 401);
    if (state.status !== 'authorized') state = { status: 'authorized', apiUrl: session.apiUrl };
    return session;
  }

  function expireSession(message: string) {
    forgetSession();
    projects = [];
    state = { status: 'error', apiUrl: state.apiUrl, message };
  }
}

const HOSTED_CONSOLE_HOSTS = new Set(['vectoree.ai', 'www.vectoree.ai', 'vectoree.net', 'www.vectoree.net']);

function publicConnect(state: ConnectPublic): ConnectPublic {
  return { ...state };
}

export function isHostedConsoleOrigin(origin: string | undefined): boolean {
  const trimmed = origin?.trim();
  if (!trimmed) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return host === 'vectoree.site' || host.endsWith('.vectoree.site') || HOSTED_CONSOLE_HOSTS.has(host);
}

function appUrlFromCallback(callbackUri: string): string {
  const url = new URL(callbackUri);
  const base = url.pathname.replace(/api\/setup\/callback$/, '');
  return `${url.origin}${base}`;
}

export function callbackUriFromOrigin(origin: string | undefined): string | null {
  const trimmed = origin?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError('Open Vectoree Starter at http://127.0.0.1:5173 before connecting');
  }
  const basePath = url.pathname.replace(/\/$/, '');
  const callback = `${url.origin}${basePath}/api/setup/callback`;
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname) && Boolean(url.port);
  if (!loopback && !isHostedConsoleOrigin(trimmed)) {
    throw new ConfigError('Connect from the forwarded address http://127.0.0.1:5173');
  }
  return callback;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function exchangeCode(
  fetchImpl: typeof fetch,
  apiUrl: string,
  body: { code: string; codeVerifier: string; redirectUri: string },
): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await fetchImpl(`${apiUrl}/api/system/auth/cli/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: body.code,
      code_verifier: body.codeVerifier,
      redirect_uri: body.redirectUri,
    }),
  });
  const data = await readBody(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(data, `Console login failed (${response.status})`));
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (typeof record.accessToken !== 'string' || !record.accessToken) {
    throw new Error('Console login did not return a session');
  }
  return {
    accessToken: record.accessToken,
    refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : undefined,
  };
}

async function fetchProjects(fetchImpl: typeof fetch, apiUrl: string, accessToken: string): Promise<ConsoleProject[]> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}/api/projects`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${apiUrl} (${reason})`, 502);
  }
  const data = await readBody(response);
  if (response.status === 401) {
    throw new ConfigError('Console login expired. Log in again.', 401);
  }
  if (!response.ok) {
    throw new ConfigError(readErrorMessage(data, `Could not list projects (${response.status})`), 502);
  }
  return readList(data, 'projects').flatMap((item) => {
    const id = text(item.id);
    if (!id) return [];
    const organization = item.organization && typeof item.organization === 'object'
      ? (item.organization as Record<string, unknown>)
      : {};
    const organizationId =
      text(item.organizationId) || text(item.organization_id) || text(item.orgId) || text(organization.id);
    const organizationName = text(item.organizationName) || text(item.organization_name) || text(organization.name);
    return [
      {
        id,
        name: text(item.name) || id,
        ...(organizationId ? { organizationId } : {}),
        ...(organizationName ? { organizationName } : {}),
      },
    ];
  });
}

async function fetchOrganizations(
  fetchImpl: typeof fetch,
  apiUrl: string,
  accessToken: string,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const response = await fetchImpl(`${apiUrl}/api/organizations`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return names;
    for (const item of readList(await readBody(response), 'organizations')) {
      const id = text(item.id);
      const name = text(item.name);
      if (id && name) names.set(id, name);
    }
  } catch {
    // Organization names are only labels; projects still list without them.
  }
  return names;
}

function readList(data: unknown, key: string): Record<string, unknown>[] {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const list = Array.isArray(data) ? data : Array.isArray(record[key]) ? record[key] : Array.isArray(record.data) ? record.data : [];
  return (list as unknown[]).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function mintProjectKey(
  fetchImpl: typeof fetch,
  apiUrl: string,
  accessToken: string,
  input: { projectId: string; projectName: string; root: string; turnstileToken?: string },
): Promise<{ apiKey: string; keyId?: string }> {
  const token = input.turnstileToken?.trim();
  const response = await fetchImpl(`${apiUrl}/api/gateway/keys`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'X-Project-Id': input.projectId,
      'User-Agent': 'VectoreeCLI',
      ...(token ? { 'X-Turnstile-Token': token } : {}),
    },
    body: JSON.stringify({
      name: `CLI — ${os.hostname()}`.slice(0, 128),
      projectId: input.projectId,
      deviceId: readDeviceId(input.root),
      localFolderPath: input.root,
      scopes: KEY_SCOPES,
    }),
  });
  const data = await readBody(response);
  if (!response.ok) {
    throw new Error(readErrorMessage(data, `Could not create a project key (${response.status})`));
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (typeof record.apiKey !== 'string' || !record.apiKey.startsWith('sk-ve-')) {
    throw new Error('Vectoree did not return a project API key');
  }
  return {
    apiKey: record.apiKey,
    keyId: typeof record.id === 'string' ? record.id : undefined,
  };
}

function readDeviceId(root: string): string {
  const file = path.join(root, '.vectoree', 'device-id');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing.slice(0, 128);
  } catch {
    // create one below
  }
  const id = randomUUID();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${id}\n`, { encoding: 'utf8', mode: 0o600 });
  return id;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}

function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return new Promise((resolve) => {
    execFile(command, args, () => resolve());
  });
}
