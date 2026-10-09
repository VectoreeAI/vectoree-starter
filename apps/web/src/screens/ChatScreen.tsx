import { useEffect, useMemo, useRef, useState } from 'react';
import {
  generateConversationTitle,
  getConversation,
  saveConversation,
  streamChat,
  type ChatImage,
  type ConversationMessage,
  type ListedModel,
} from '../api';
import { getLocale, translate, useI18n } from '../i18n';

type ThreadMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: ChatImage;
  generated?: { url: string }[];
  generatingCount?: number;
  pending?: boolean;
};

function nextId(): string {
  return crypto.randomUUID();
}

export function ChatScreen({
  conversationId,
  titledByModel,
  models,
  model,
  imageModel,
  onTitled,
  onSaved,
}: {
  conversationId: string | null;
  titledByModel: boolean;
  models: ListedModel[];
  model: string;
  imageModel: string;
  onTitled: (id: string, title: string) => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [image, setImage] = useState<ChatImage | null>(null);
  const [error, setError] = useState('');
  const [streaming, setStreaming] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<ThreadMessage[]>([]);
  const liveRef = useRef(conversationId);
  liveRef.current = conversationId;

  function showMessages(next: ThreadMessage[], id: string) {
    if (liveRef.current !== id) return;
    messagesRef.current = next;
    setMessages(next);
  }

  useEffect(() => {
    if (!conversationId) {
      messagesRef.current = [];
      setMessages([]);
      return undefined;
    }
    let cancelled = false;
    setDraft('');
    setImage(null);
    setError('');
    setStreaming(false);
    messagesRef.current = [];
    setMessages([]);
    void getConversation(conversationId)
      .then((conversation) => {
        if (cancelled) return;
        const loaded = conversation.messages.map(hydrate);
        messagesRef.current = loaded;
        setMessages(loaded);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : translate(getLocale(), 'loadChatFail'));
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const selected = models.find((item) => item.id === model);
  const visionHint = useMemo(() => {
    if (!image || selected?.vision) return '';
    const vision = models.find((item) => item.chat && item.vision);
    return vision ? t('visionWith', { model: vision.id }) : t('visionWithout');
  }, [image, models, selected, t]);

  async function onPickFile(file: File | undefined) {
    if (!file) return;
    const mediaType = file.type === 'image/jpg' ? 'image/jpeg' : file.type;
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) {
      setError(t('badImage'));
      return;
    }
    const data = await readBase64(file);
    setImage({ mediaType, data, previewUrl: `data:${mediaType};base64,${data}` });
    setError('');
  }

  function patchTurn(
    turn: ThreadMessage[],
    id: string,
    assistantId: string,
    update: (item: ThreadMessage) => ThreadMessage,
  ): ThreadMessage[] {
    const next = turn.map((item) => (item.id === assistantId ? update(item) : item));
    showMessages(next, id);
    return next;
  }

  async function persist(id: string, next: ThreadMessage[], nameIfNeeded: boolean) {
    const stored = next.map(toStored);
    try {
      await saveConversation(id, stored);
      onSaved(id);
    } catch (err) {
      if (liveRef.current === id) setError(err instanceof Error ? err.message : t('saveChatFail'));
      return;
    }
    const assistant = next.find((item) => item.role === 'assistant' && (item.content.trim() || item.generated?.length));
    if (!nameIfNeeded || !assistant) return;
    try {
      const titled = await generateConversationTitle(id, model);
      onTitled(titled.id, titled.title);
    } catch (err) {
      if (liveRef.current === id) setError(err instanceof Error ? err.message : t('titleFailed'));
    }
  }

  async function onSend() {
    const content = draft.trim();
    const id = conversationId;
    if ((!content && !image) || streaming || !id) return;
    const userMessage: ThreadMessage = {
      id: nextId(),
      role: 'user',
      content,
      ...(image ? { image } : {}),
    };
    const assistantId = nextId();
    const history = [...messagesRef.current, userMessage];
    const needsTitle = !titledByModel;
    let turn: ThreadMessage[] = [...history, { id: assistantId, role: 'assistant', content: '', pending: true }];
    showMessages(turn, id);
    setDraft('');
    setImage(null);
    setError('');
    setStreaming(true);
    let failed = false;
    try {
      await streamChat(
        {
          model,
          imageTool: Boolean(imageModel),
          ...(imageModel ? { imageModel } : {}),
          messages: history.map((item) => ({
            role: item.role,
            content: item.content,
            ...(item.image?.data ? { image: { mediaType: item.image.mediaType, data: item.image.data } } : {}),
          })),
        },
        {
          onDelta: (delta) => {
            turn = patchTurn(turn, id, assistantId, (item) => ({ ...item, content: item.content + delta, pending: true }));
          },
          onImages: (images) => {
            turn = patchTurn(turn, id, assistantId, (item) => ({
              ...item,
              generated: [...(item.generated ?? []), ...images],
              generatingCount: undefined,
              pending: true,
            }));
          },
          onImageStatus: (payload) => {
            turn = patchTurn(turn, id, assistantId, (item) => {
              if (payload.status === 'error') return { ...item, generatingCount: undefined, pending: true };
              const count = Math.min(4, Math.max(1, Math.floor(payload.n ?? 1)));
              return { ...item, generatingCount: count, pending: true };
            });
          },
        },
      );
      turn = turn.map((item) =>
        item.id === assistantId ? { ...item, pending: false, generatingCount: undefined } : item,
      );
      showMessages(turn, id);
    } catch (err) {
      failed = true;
      const message = err instanceof Error ? err.message : t('chatFailed');
      if (liveRef.current === id) setError(message);
      turn = turn.map((item) =>
        item.id === assistantId
          ? { ...item, content: item.content || message, pending: false, generatingCount: undefined }
          : item,
      );
      showMessages(turn, id);
    } finally {
      if (liveRef.current === id) setStreaming(false);
      await persist(id, turn, needsTitle && !failed);
    }
  }

  return (
      <div className="chat-shell">
        <div className="messages" ref={scroller}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <h2 className="panel-title">{t('chatStartTitle')}</h2>
              <p className="note">{t('chatStartNote')}</p>
              <p className="chat-models">
                <span className="eyebrow">{t('chatModel')}</span>
                <span className="mono">{model}</span>
              </p>
              {imageModel ? (
                <p className="chat-models">
                  <span className="eyebrow">{t('imageModel')}</span>
                  <span className="mono">{imageModel}</span>
                </p>
              ) : (
                <p className="note">{t('noImageModel')}</p>
              )}
              <p className="note">{t('chatStartSettings')}</p>
              <p className="chat-credit">{t('chatStartEyebrow')}</p>
            </div>
          ) : (
          <div className="chat-column">
          {messages.map((item) => (
            <article key={item.id} className={item.role === 'user' ? 'bubble user' : 'bubble'}>
              <div className="who">{item.role === 'user' ? t('you') : model}</div>
              {item.image ? <img src={item.image.previewUrl} alt="" /> : null}
              {item.generatingCount
                ? Array.from({ length: item.generatingCount }, (_, index) => (
                    <div key={`drawing-${index}`} className="gen-placeholder" role="status">
                      <div className="gen-placeholder-copy">
                        <div className="gen-placeholder-label">{t('drawing')}</div>
                      </div>
                    </div>
                  ))
                : null}
              {item.generated?.map((generated) => (
                <img key={generated.url} className="gen" src={generated.url} alt={t('generated')} />
              ))}
              <div className="prose">
                {item.content}
                {item.pending ? <span className="caret" /> : null}
              </div>
            </article>
          ))}
          </div>
          )}
        </div>
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void onSend();
          }}
        >
          {image ? (
            <div className="preview">
              <img src={image.previewUrl} alt="" />
              <button className="btn-ghost" type="button" onClick={() => setImage(null)}>
                {t('remove')}
              </button>
            </div>
          ) : null}
          {visionHint ? <p className="note">{visionHint}</p> : null}
          {error ? <div className="error">{error}</div> : null}
          <textarea
            value={draft}
            placeholder={t('message')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void onSend();
              }
            }}
          />
          <div className="composer-bar">
            <div className="composer-tools">
              <input
                ref={fileRef}
                hidden
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(event) => {
                  void onPickFile(event.target.files?.[0]);
                  event.target.value = '';
                }}
              />
              <button className="icon-tool" type="button" aria-label={t('attach')} disabled={streaming} onClick={() => fileRef.current?.click()}>
                <ImageIcon />
              </button>
            </div>
            <button className="btn" type="submit" disabled={streaming || (!draft.trim() && !image)}>
              {streaming ? t('streaming') : t('send')}
            </button>
          </div>
        </form>
      </div>
  );
}

function ImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="4" y="5" width="2" height="2" fill="currentColor" />
      <path d="M2 12.5 L6 8.5 L8.5 10.5 L11 8 L14 12" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function toStored(item: ThreadMessage): ConversationMessage {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    ...(item.image?.data ? { image: { mediaType: item.image.mediaType, data: item.image.data } } : {}),
    ...(item.generated?.length ? { generated: item.generated.map((image) => ({ url: image.url })) } : {}),
  };
}

function hydrate(item: ConversationMessage): ThreadMessage {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    ...(item.image?.data
      ? { image: { mediaType: item.image.mediaType, data: item.image.data, previewUrl: `data:${item.image.mediaType};base64,${item.image.data}` } }
      : {}),
    ...(item.generated?.length ? { generated: item.generated } : {}),
  };
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      resolve(comma >= 0 ? url.slice(comma + 1) : url);
    };
    reader.onerror = () => reject(reader.error ?? new Error(translate(getLocale(), 'readImageFail')));
    reader.readAsDataURL(file);
  });
}
