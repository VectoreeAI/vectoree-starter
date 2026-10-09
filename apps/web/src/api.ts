export type SetupStatus = {
  linked: boolean;
  mode?: 'local' | 'cloud';
  /** Cloud only: this browser holds a redeemed preview. */
  previewed?: boolean;
  projectId?: string;
  projectName?: string;
  apiUrl?: string;
  warning?: string;
};

export type ConnectStatus = {
  status: 'idle' | 'pending' | 'callback' | 'authorized' | 'linked' | 'error';
  authorizeUrl?: string;
  message?: string;
  apiUrl?: string;
  projectId?: string;
  projectName?: string;
};

export type PublicUser = {
  id: string;
  email: string;
  name?: string;
};

export type ListedModel = {
  id: string;
  name: string;
  chat: boolean;
  vision: boolean;
  imageOutput?: boolean;
};

export type ChatImage = {
  mediaType: string;
  data: string;
  previewUrl: string;
};

function withBase(path: string): string {
  if (!path.startsWith('/')) return path;
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

export const PREVIEW_REQUIRED = 'preview_required';
export const PREVIEW_EXPIRED_EVENT = 'starter:preview-expired';

export class ApiError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

function failure(status: number, data: { message?: string; code?: string } | null, fallback: string): ApiError {
  if (data?.code === PREVIEW_REQUIRED) window.dispatchEvent(new Event(PREVIEW_EXPIRED_EVENT));
  return new ApiError(data?.message || `${fallback} (${status})`, data?.code);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBase(path), {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  const data = (await res.json().catch(() => null)) as (T & { message?: string; code?: string }) | null;
  if (!res.ok) throw failure(res.status, data, 'Request failed');
  return data as T;
}

export function redeemPreview(ticket: string): Promise<{ projectId: string; organizationId?: string }> {
  return request('/api/preview/redeem', { method: 'POST', body: JSON.stringify({ ticket }) });
}

export function getSetupStatus(): Promise<SetupStatus> {
  return request('/api/setup/status');
}

export function checkSetup(): Promise<SetupStatus & { message?: string }> {
  return request('/api/setup/status?validate=1');
}

export type ConsoleProject = { id: string; name: string; organizationId?: string; organizationName?: string };

export function startConnect(input: {
  apiUrl: string;
  openBrowser?: boolean;
  redirectOrigin?: string;
}): Promise<ConnectStatus> {
  return request('/api/setup/connect', { method: 'POST', body: JSON.stringify(input) });
}

export function getConnect(): Promise<ConnectStatus> {
  return request('/api/setup/connect');
}

export function exchangeConsoleCode(): Promise<ConnectStatus> {
  return request('/api/setup/token', { method: 'POST' });
}

export function listConsoleProjects(): Promise<{ projects: ConsoleProject[] }> {
  return request('/api/setup/projects');
}

export function linkProject(projectId: string): Promise<ConnectStatus> {
  return request('/api/setup/link', { method: 'POST', body: JSON.stringify({ projectId }) });
}

export function getSession(): Promise<{ user: PublicUser | null }> {
  return request('/api/auth/session');
}

export function getAuthMethods(): Promise<{ codeLength?: number; verifyEmailMethod?: string }> {
  return request('/api/auth/methods');
}

export type EmailStartResult = { next: 'code' } | { next: 'signed-in'; user: PublicUser } | { user: null; message?: string };

export function startEmailAuth(email: string) {
  return request<EmailStartResult>('/api/auth/email/start', { method: 'POST', body: JSON.stringify({ email }) });
}

export type PasswordSetResult = { next: 'code' } | { ok: true };

export function setAccountPassword(input: { password: string; confirmPassword: string; code?: string }) {
  return request<PasswordSetResult>('/api/account/password', { method: 'POST', body: JSON.stringify(input) });
}

export function loginAccount(input: { email: string; password: string }) {
  return request<AuthResult>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
}

export function verifyEmail(input: { email: string; otp: string }) {
  return request<AuthResult>('/api/auth/verify', { method: 'POST', body: JSON.stringify(input) });
}

export function resendCode(email: string) {
  return request<{ ok: boolean }>('/api/auth/resend', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function logoutAccount() {
  return request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' });
}

export function getSettings(): Promise<{ apiUrl: string; apiKey: string }> {
  return request('/api/settings');
}

export function saveSettings(input: { apiUrl: string; apiKey: string }): Promise<{ apiUrl: string; apiKey: string }> {
  return request('/api/settings', { method: 'PATCH', body: JSON.stringify(input) });
}

export function getModels(): Promise<{ models: ListedModel[]; defaultModel: string; imageModel: string | null }> {
  return request('/api/models');
}

export type ConversationMeta = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  titledByModel?: boolean;
};

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: { mediaType: string; data?: string };
  generated?: { url: string }[];
};

export type Conversation = ConversationMeta & { messages: ConversationMessage[] };

export function listConversations(): Promise<{ conversations: ConversationMeta[] }> {
  return request('/api/conversations');
}

export function createConversation(force = false): Promise<ConversationMeta> {
  return request('/api/conversations', { method: 'POST', body: JSON.stringify(force ? { force: true } : {}) });
}

export function getConversation(id: string): Promise<Conversation> {
  return request(`/api/conversations/${encodeURIComponent(id)}`);
}

export function saveConversation(id: string, messages: ConversationMessage[]): Promise<ConversationMeta> {
  return request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ messages }),
  });
}

export function renameConversation(id: string, title: string): Promise<ConversationMeta> {
  return request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export function deleteConversation(id: string): Promise<{ ok: boolean }> {
  return request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function generateConversationTitle(id: string, model: string): Promise<{ id: string; title: string }> {
  return request(`/api/conversations/${encodeURIComponent(id)}/generate-title`, {
    method: 'POST',
    body: JSON.stringify({ model }),
  });
}

export type TableColumn = {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey?: boolean;
};

export function getTables(): Promise<{ tables: string[] }> {
  return request('/api/database/tables');
}

export function getTableSchema(table: string): Promise<{ tableName: string; columns: TableColumn[] }> {
  return request(`/api/database/tables/${encodeURIComponent(table)}/schema`);
}

export function getRecords(
  table: string,
  query: { limit: number; offset: number; order?: string },
): Promise<{ records: Array<Record<string, unknown>>; total?: number }> {
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
  if (query.order) params.set('order', query.order);
  return request(`/api/database/tables/${encodeURIComponent(table)}/records?${params}`);
}

export function createRecord(table: string, row: Record<string, unknown>) {
  return request<{ records: Array<Record<string, unknown>> }>(
    `/api/database/tables/${encodeURIComponent(table)}/records`,
    { method: 'POST', body: JSON.stringify(row) },
  );
}

export function updateRecord(table: string, id: string, row: Record<string, unknown>) {
  return request<{ records: Array<Record<string, unknown>> }>(
    `/api/database/tables/${encodeURIComponent(table)}/records/${encodeURIComponent(id)}`,
    { method: 'PATCH', body: JSON.stringify(row) },
  );
}

export function deleteRecord(table: string, id: string) {
  return request<{ ok: boolean }>(
    `/api/database/tables/${encodeURIComponent(table)}/records/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

export function getBuckets(): Promise<{ buckets: StorageBucket[] }> {
  return request('/api/storage/buckets');
}

export function createBucket(bucketName: string, isPublic: boolean) {
  return request('/api/storage/buckets', { method: 'POST', body: JSON.stringify({ bucketName, isPublic }) });
}

export function deleteBucket(bucket: string) {
  return request<{ ok: boolean }>(`/api/storage/buckets/${encodeURIComponent(bucket)}`, { method: 'DELETE' });
}

export function getObjects(
  bucket: string,
  query: { prefix?: string; limit?: number; offset?: number },
): Promise<{ objects: StorageObject[]; pagination?: { total: number } }> {
  const params = new URLSearchParams();
  if (query.prefix) params.set('prefix', query.prefix);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.offset) params.set('offset', String(query.offset));
  const suffix = params.toString();
  return request(`/api/storage/buckets/${encodeURIComponent(bucket)}/objects${suffix ? `?${suffix}` : ''}`);
}

export function uploadObject(bucket: string, file: File, key?: string) {
  const body = new FormData();
  body.append('file', file);
  if (key?.trim()) body.append('key', key.trim());
  return request<StorageObject>(`/api/storage/buckets/${encodeURIComponent(bucket)}/objects`, { method: 'POST', body });
}

export function deleteObject(bucket: string, key: string) {
  return request<{ ok: boolean }>(
    `/api/storage/buckets/${encodeURIComponent(bucket)}/objects?key=${encodeURIComponent(key)}`,
    { method: 'DELETE' },
  );
}

export function objectDownloadUrl(bucket: string, key: string): string {
  return withBase(`/api/storage/buckets/${encodeURIComponent(bucket)}/objects/content?key=${encodeURIComponent(key)}`);
}

export type AuthResult = {
  user: PublicUser | null;
  requireEmailVerification?: boolean;
  message?: string;
};

export type OutboundMessage = {
  role: 'user' | 'assistant';
  content: string;
  image?: { mediaType: string; data: string };
};

export type GeneratedImage = { url: string };

export type ImageStatus = { status: 'generating' | 'error'; n?: number };

export type DatabaseEvent = { action: 'tables_changed' | 'records_changed'; table?: string };

export type StorageEvent = { action: 'buckets_changed' | 'objects_changed'; bucket?: string };

export type StorageBucket = { name: string; isPublic?: boolean; createdAt?: string };

export type StorageObject = { key: string; size?: number; mimeType?: string; uploadedAt?: string; url?: string };

export async function streamChat(
  input: { model: string; messages: OutboundMessage[]; imageTool?: boolean; imageModel?: string },
  handlers: {
    onDelta: (text: string) => void;
    onImages?: (images: GeneratedImage[]) => void;
    onImageStatus?: (payload: ImageStatus) => void;
    onDatabase?: (payload: DatabaseEvent) => void;
    onStorage?: (payload: StorageEvent) => void;
  },
): Promise<void> {
  const res = await fetch(withBase('/api/chat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('text/event-stream') || !res.body) {
    const data = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
    throw failure(res.status, data, 'Chat failed');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        eventName = '';
        continue;
      }
      if (trimmed.startsWith('event:')) {
        eventName = trimmed.slice(6).trim();
        continue;
      }
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload) as {
          images?: GeneratedImage[];
          status?: unknown;
          n?: unknown;
          action?: unknown;
          table?: unknown;
          bucket?: unknown;
          choices?: Array<{ delta?: { content?: unknown } }>;
        };
        if (eventName === 'starter.storage' && (json.action === 'buckets_changed' || json.action === 'objects_changed')) {
          handlers.onStorage?.({
            action: json.action,
            ...(typeof json.bucket === 'string' ? { bucket: json.bucket } : {}),
          });
        } else if (eventName === 'starter.database' && (json.action === 'tables_changed' || json.action === 'records_changed')) {
          handlers.onDatabase?.({
            action: json.action,
            ...(typeof json.table === 'string' ? { table: json.table } : {}),
          });
        } else if (eventName === 'starter.images') {
          const images = (json.images ?? []).filter((image) => image && typeof image.url === 'string' && image.url);
          if (images.length > 0) handlers.onImages?.(images);
        } else if (eventName === 'starter.image_status' && (json.status === 'generating' || json.status === 'error')) {
          handlers.onImageStatus?.({
            status: json.status,
            ...(typeof json.n === 'number' ? { n: json.n } : {}),
          });
        } else {
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) handlers.onDelta(delta);
        }
      } catch {
        // Ignore keep-alive comments and partial frames.
      }
    }
  }
}
