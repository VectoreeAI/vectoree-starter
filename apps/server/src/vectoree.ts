export const FALLBACK_MODEL = 'vectoree/auto';

export type ListedModel = {
  id: string;
  name: string;
  vision: boolean;
  imageOutput: boolean;
};

type RawModel = {
  id?: unknown;
  name?: unknown;
  displayName?: unknown;
  inputModality?: unknown;
  outputModality?: unknown;
  architecture?: {
    input_modalities?: unknown;
    output_modalities?: unknown;
  };
};

export function parseModelList(payload: unknown): ListedModel[] {
  const data = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : [];
  const models: ListedModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as RawModel;
    if (typeof raw.id !== 'string' || !raw.id.trim()) continue;
    const name =
      typeof raw.name === 'string' && raw.name.trim()
        ? raw.name.trim()
        : typeof raw.displayName === 'string' && raw.displayName.trim()
          ? raw.displayName.trim()
          : raw.id;
    models.push({
      id: raw.id,
      name,
      vision: isVisionModel(raw),
      imageOutput: isImageOutputModel(raw),
    });
  }
  return models;
}

export function pickDefaultModel(models: ListedModel[]): string {
  return models.find((model) => model.vision)?.id ?? models[0]?.id ?? FALLBACK_MODEL;
}

export function pickImageModel(models: ListedModel[]): string | null {
  const images = models.filter((model) => model.imageOutput);
  const grok = images.filter((model) => /grok-imagine/i.test(model.id));
  if (grok.length > 0) return grok.find((model) => /quality/i.test(model.id))?.id ?? grok[0].id;
  return images[0]?.id ?? null;
}

export function isVisionModel(model: RawModel): boolean {
  const input = modalityList(model.inputModality, model.architecture?.input_modalities);
  const output = modalityList(model.outputModality, model.architecture?.output_modalities);
  const readsImages = input.includes('image');
  const writesText = output.length === 0 || output.includes('text');
  return readsImages && writesText;
}

export function isImageOutputModel(model: RawModel): boolean {
  const output = modalityList(model.outputModality, model.architecture?.output_modalities).map((item) =>
    item.toLowerCase(),
  );
  return output.includes('image') && !output.includes('text');
}

function modalityList(primary: unknown, fallback: unknown): string[] {
  const source = Array.isArray(primary) ? primary : Array.isArray(fallback) ? fallback : [];
  return source.filter((item): item is string => typeof item === 'string');
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export type ChatImage = {
  mediaType: string;
  data: string;
};

export type ChatTurn = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  image?: ChatImage;
};

export function buildChatMessages(turns: ChatTurn[]): Array<Record<string, unknown>> {
  return turns.map((turn) => {
    const text = turn.content.trim();
    if (turn.role !== 'user' || !turn.image) {
      return { role: turn.role, content: text };
    }
    const parts: Array<Record<string, unknown>> = [];
    if (text) parts.push({ type: 'text', text });
    parts.push({
      type: 'image_url',
      image_url: { url: imageDataUrl(turn.image) },
    });
    return { role: 'user', content: parts };
  });
}

export function imageDataUrl(image: ChatImage): string {
  let mediaType = image.mediaType.toLowerCase().trim();
  if (mediaType === 'image/jpg') mediaType = 'image/jpeg';
  if (!IMAGE_TYPES.has(mediaType)) {
    throw new Error('Unsupported image type. Use png, jpeg, webp, or gif.');
  }
  let data = image.data.trim();
  const embedded = /^data:[^;]+;base64,([\s\S]+)$/.exec(data);
  if (embedded?.[1]) data = embedded[1];
  data = data.replace(/\s/g, '');
  if (!data || data.length > 6_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('Image must be a base64 payload under 4MB.');
  }
  return `data:${mediaType};base64,${data}`;
}

export function readErrorMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== 'object') return fallback;
  const record = data as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  const error = record.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    const nested = (error as { message?: unknown }).message;
    if (typeof nested === 'string' && nested.trim()) return nested;
  }
  return fallback;
}

export type PublicUser = {
  id: string;
  email: string;
  name?: string;
};

export type ClientAuthBody =
  | { user: PublicUser; requireEmailVerification?: false }
  | { user: null; requireEmailVerification: true; message: string }
  | { user: null; message: string };

export function readSessionTokens(data: unknown): { accessToken: string; refreshToken?: string } | null {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (typeof record.accessToken !== 'string' || !record.accessToken) return null;
  const refreshToken = typeof record.refreshToken === 'string' ? record.refreshToken : undefined;
  return { accessToken: record.accessToken, refreshToken };
}

export function toClientAuthBody(status: number, data: unknown): { httpStatus: number; body: ClientAuthBody } {
  const tokens = readSessionTokens(data);
  const user = readPublicUser(data);
  if (status >= 200 && status < 300 && tokens && user) {
    return { httpStatus: 200, body: { user } };
  }
  if (needsEmailVerification(status, data)) {
    return {
      httpStatus: 200,
      body: {
        user: null,
        requireEmailVerification: true,
        message: 'Enter the 8-digit code sent to your email.',
      },
    };
  }
  return {
    httpStatus: status >= 400 ? status : 502,
    body: {
      user: null,
      message: readErrorMessage(data, 'Auth request failed'),
    },
  };
}

export function readPublicUser(data: unknown): PublicUser | null {
  if (!data || typeof data !== 'object') return null;
  const user = (data as { user?: unknown }).user;
  if (!user || typeof user !== 'object') return null;
  const record = user as Record<string, unknown>;
  if (typeof record.email !== 'string' || !record.email) return null;
  const profile = record.profile;
  const name =
    profile && typeof profile === 'object' && typeof (profile as { name?: unknown }).name === 'string'
      ? (profile as { name: string }).name
      : undefined;
  return {
    id: typeof record.id === 'string' ? record.id : '',
    email: record.email,
    ...(name ? { name } : {}),
  };
}

function needsEmailVerification(status: number, data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const record = data as Record<string, unknown>;
  if (record.requireEmailVerification === true) return true;
  if (status === 403 && record.error === 'AUTH_NEED_VERIFICATION') return true;
  return false;
}
