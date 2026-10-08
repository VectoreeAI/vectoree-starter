import type { Context } from 'hono';
import { ConfigError, DEFAULT_API_URL, deploymentMode, normalizeApiUrl, resolveConfig, type AppConfig } from './config.js';
import { readPreview, type PreviewRecord } from './preview.js';
import { readErrorMessage } from './vectoree.js';

export const PREVIEW_REQUIRED = 'preview_required';

export type ProjectScope = AppConfig & {
  apiKey: string;
  /** Cloud only. Conversations are stored per project. */
  conversationProjectId?: string;
  previewId?: string;
};

export function resolveScope(c: Context, root: string, env: NodeJS.ProcessEnv): ProjectScope {
  if (deploymentMode(env) === 'cloud') {
    const preview = readPreview(c);
    if (!preview) throw previewRequired();
    return {
      apiUrl: preview.apiUrl,
      apiKey: preview.apiKey,
      projectId: preview.projectId,
      linked: true,
      conversationProjectId: preview.projectId,
      previewId: preview.id,
    };
  }
  const config = resolveConfig(root, env);
  if (!config.linked || !config.apiKey) throw new ConfigError('Link a Vectoree project first');
  return { ...config, apiKey: config.apiKey };
}

export function previewRequired(): ConfigError {
  return new ConfigError('This preview has expired. Open it again from Vectoree.', 401, PREVIEW_REQUIRED);
}

export function cloudApiUrl(env: NodeJS.ProcessEnv): string {
  return normalizeApiUrl(env.VECTOREE_API_URL?.trim() || DEFAULT_API_URL);
}

export function parseTicket(body: unknown): string {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const ticket = typeof record.ticket === 'string' ? record.ticket.trim() : '';
  if (ticket.length < 16 || ticket.length > 512 || /\s/.test(ticket)) throw previewRequired();
  return ticket;
}

export async function redeemTicket(fetchImpl: typeof fetch, apiUrl: string, ticket: string): Promise<PreviewRecord> {
  let upstream: Response;
  try {
    upstream = await fetchImpl(`${apiUrl}/api/system/starter/preview/redeem`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'network error';
    throw new ConfigError(`Could not reach Vectoree at ${apiUrl} (${reason})`, 502);
  }
  const text = await upstream.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    data = null;
  }
  if (upstream.status >= 400 && upstream.status < 500) throw previewRequired();
  if (!upstream.ok) {
    throw new ConfigError(readErrorMessage(data, `Vectoree could not open the preview (${upstream.status})`), 502);
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey : '';
  const projectId = typeof record.projectId === 'string' ? record.projectId.trim() : '';
  const organizationId = typeof record.organizationId === 'string' ? record.organizationId.trim() : '';
  if (!apiKey.startsWith('sk-ve-') || !projectId) {
    throw new ConfigError('Vectoree returned an unexpected preview', 502);
  }
  return { apiUrl, apiKey, projectId, ...(organizationId ? { organizationId } : {}) };
}
