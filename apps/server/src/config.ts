import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_API_URL = 'https://vectoree.ai';

export type DeploymentMode = 'local' | 'cloud';

export function deploymentMode(env: NodeJS.ProcessEnv = process.env): DeploymentMode {
  const raw = env.DEPLOY_MODE?.trim() ?? '';
  if (raw === '' || raw === 'local') return 'local';
  if (raw === 'cloud') return 'cloud';
  throw new ConfigError('DEPLOY_MODE must be local or cloud');
}

export type AppConfig = {
  apiUrl: string;
  projectId?: string;
  projectName?: string;
  apiKey?: string;
  linked: boolean;
};

export type SetupInput = {
  apiUrl: string;
  projectId: string;
  apiKey: string;
};

export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 8; i += 1) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
        if (pkg.workspaces) return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

const shellCredentials = new WeakMap<NodeJS.ProcessEnv, { projectId?: string; apiKey?: string }>();

function rememberShellCredentials(env: NodeJS.ProcessEnv): void {
  if (shellCredentials.has(env)) return;
  shellCredentials.set(env, {
    projectId: env.VECTOREE_PROJECT_ID,
    apiKey: env.VECTOREE_API_KEY,
  });
}

export function loadEnvFiles(root: string, env: NodeJS.ProcessEnv = process.env): void {
  rememberShellCredentials(env);
  const merged = readDiskEnv(root);
  for (const [key, value] of Object.entries(merged)) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function resolveConfig(root: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  rememberShellCredentials(env);
  const file = readConfigFile(root);
  const disk = readDiskEnv(root);
  const fileLinked = usableLink(file.projectId, file.apiKey);
  const diskLinked = usableLink(disk.VECTOREE_PROJECT_ID, disk.VECTOREE_API_KEY);
  if (!fileLinked && !diskLinked) {
    const shell = shellCredentials.get(env);
    assignOrDelete(env, 'VECTOREE_PROJECT_ID', shell?.projectId);
    assignOrDelete(env, 'VECTOREE_API_KEY', shell?.apiKey);
  }

  const apiUrl = normalizeApiUrl(file.apiUrl || disk.VECTOREE_API_URL || env.VECTOREE_API_URL || DEFAULT_API_URL);
  const projectId = fileLinked
    ? blankToUndefined(file.projectId)
    : diskLinked
      ? blankToUndefined(disk.VECTOREE_PROJECT_ID)
      : blankToUndefined(env.VECTOREE_PROJECT_ID);
  const apiKey = fileLinked
    ? blankToUndefined(file.apiKey)
    : diskLinked
      ? blankToUndefined(disk.VECTOREE_API_KEY)
      : blankToUndefined(env.VECTOREE_API_KEY);
  const projectName = blankToUndefined(file.projectName);
  return {
    apiUrl,
    projectId,
    projectName,
    apiKey,
    linked: usableLink(projectId, apiKey),
  };
}

export function publicSetupStatus(config: AppConfig): {
  linked: boolean;
  projectId?: string;
  projectName?: string;
  apiUrl?: string;
} {
  if (!config.linked) return { linked: false };
  return {
    linked: true,
    ...(config.projectId ? { projectId: config.projectId } : {}),
    ...(config.projectName ? { projectName: config.projectName } : {}),
    apiUrl: config.apiUrl,
  };
}

export type LinkedCredentials = {
  apiUrl: string;
  projectId: string;
  projectName?: string;
  apiKey: string;
  keyId?: string;
  accessToken?: string;
  refreshToken?: string;
};

export function writeLinkedConfig(root: string, input: LinkedCredentials, env?: NodeJS.ProcessEnv): void {
  const dir = path.join(root, '.vectoree');
  const file = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readConfigFile(root);
  const next: Record<string, string | undefined> = {
    ...existing,
    apiUrl: input.apiUrl,
    accessToken: input.accessToken ?? existing.accessToken,
    refreshToken: input.refreshToken ?? existing.refreshToken,
    apiKey: input.apiKey,
    projectId: input.projectId,
    projectName: input.projectName ?? existing.projectName,
    keyId: input.keyId ?? existing.keyId,
  };
  for (const alias of ['api_url', 'api_key', 'project_id', 'project_name', 'key_id']) {
    delete next[alias];
  }
  const ordered: Record<string, string> = {};
  for (const key of ['apiUrl', 'accessToken', 'refreshToken', 'apiKey', 'projectId', 'projectName', 'keyId']) {
    const value = next[key];
    if (value) ordered[key] = value;
    delete next[key];
  }
  for (const [key, value] of Object.entries(next)) {
    if (value) ordered[key] = value;
  }
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(ordered, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod can fail on some filesystems; the file is still written.
  }
  syncEnvFile(root, {
    VECTOREE_API_URL: input.apiUrl,
    VECTOREE_PROJECT_ID: input.projectId,
    VECTOREE_API_KEY: input.apiKey,
  });
  if (env) {
    rememberShellCredentials(env);
    env.VECTOREE_API_URL = input.apiUrl;
    env.VECTOREE_PROJECT_ID = input.projectId;
    env.VECTOREE_API_KEY = input.apiKey;
  }
}

export function syncEnvFile(root: string, updates: Record<string, string>): void {
  const file = path.join(root, '.env');
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) {
    throw new ConfigError('.env is a directory. Remove it and create a file before saving credentials.');
  }
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.writeFileSync(file, upsertEnv(current, updates), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // ignore
  }
}

export function upsertEnv(content: string, updates: Record<string, string>): string {
  const lines = content.split('\n');
  const seen = new Set<string>();
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match || !(match[1] in updates)) return line;
    seen.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  while (next.length > 0 && next[next.length - 1] === '') next.pop();
  return `${next.join('\n')}\n`;
}

export function parseSetupInput(body: unknown): SetupInput {
  if (!body || typeof body !== 'object') {
    throw new ConfigError('Expected a JSON object');
  }
  const record = body as Record<string, unknown>;
  const apiUrl = normalizeApiUrl(typeof record.apiUrl === 'string' ? record.apiUrl : '');
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : '';
  if (!projectId || projectId.length > 200 || /[\r\n]/.test(projectId)) {
    throw new ConfigError('projectId is required');
  }
  if (projectId.startsWith('sk-')) {
    throw new ConfigError('projectId looks like an API key');
  }
  if (!apiKey.startsWith('sk-ve-')) {
    throw new ConfigError('apiKey must be a project key starting with sk-ve-');
  }
  return { apiUrl, projectId, apiKey };
}

export function writeProjectConfig(root: string, input: SetupInput): void {
  const dir = path.join(root, '.vectoree');
  const file = path.join(dir, 'config.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readConfigFile(root);
  const next: Record<string, string | undefined> = {
    ...existing,
    apiUrl: input.apiUrl,
    projectId: input.projectId,
    apiKey: input.apiKey,
  };
  for (const alias of ['api_url', 'api_key', 'project_id', 'project_name', 'key_id']) {
    delete next[alias];
  }
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(file, 0o600);
  } catch {
    // chmod can fail on some filesystems; the file is still written.
  }
}

export function normalizeApiUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new ConfigError('apiUrl is required');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError('apiUrl must be an http(s) origin, for example https://vectoree.ai');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError('apiUrl must use http or https');
  }
  if (url.username || url.password) throw new ConfigError('apiUrl must not include credentials');
  if (url.search || url.hash) throw new ConfigError('apiUrl must be an origin, without a query or hash');
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ConfigError('Use the API origin only, for example https://vectoree.ai');
  }
  return url.origin;
}

export class ConfigError extends Error {
  readonly status: 400 | 401 | 404 | 409 | 502;
  readonly code?: string;

  constructor(message: string, status: 400 | 401 | 404 | 409 | 502 = 400, code?: string) {
    super(message);
    this.name = 'ConfigError';
    this.status = status;
    this.code = code;
  }
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function usableLink(projectId: string | undefined, apiKey: string | undefined): boolean {
  return Boolean(blankToUndefined(projectId) && blankToUndefined(apiKey)?.startsWith('sk-ve-'));
}

function assignOrDelete(env: NodeJS.ProcessEnv, key: 'VECTOREE_PROJECT_ID' | 'VECTOREE_API_KEY', value: string | undefined): void {
  if (value === undefined) delete env[key];
  else env[key] = value;
}

function readDiskEnv(root: string): Record<string, string> {
  return {
    ...parseEnvFile(path.join(root, '.env')),
    ...parseEnvFile(path.join(root, '.env.local')),
  };
}

function readConfigFile(root: string): Record<string, string | undefined> {
  const file = path.join(root, '.vectoree', 'config.json');
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const record = raw as Record<string, unknown>;
    const out: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === 'string') out[key] = value;
    }
    // CLI writes camelCase. Accept snake_case aliases and expose the canonical names.
    out.apiUrl = firstString(out, 'apiUrl', 'api_url');
    out.projectId = firstString(out, 'projectId', 'project_id');
    out.apiKey = firstString(out, 'apiKey', 'api_key');
    out.projectName = firstString(out, 'projectName', 'project_name');
    out.keyId = firstString(out, 'keyId', 'key_id');
    return out;
  } catch {
    return {};
  }
}

function firstString(record: Record<string, string | undefined>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

function parseEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}
