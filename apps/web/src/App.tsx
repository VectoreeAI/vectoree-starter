import { useEffect, useRef, useState } from 'react';
import {
  createConversation,
  deleteConversation,
  renameConversation,
  getModels,
  getSession,
  getSetupStatus,
  listConversations,
  logoutAccount,
  PREVIEW_EXPIRED_EVENT,
  PREVIEW_REQUIRED,
  redeemPreview,
  ApiError,
  type ConversationMeta,
  type ListedModel,
  type PublicUser,
} from './api';
import { AuthScreen } from './screens/AuthScreen';
import { ChatScreen } from './screens/ChatScreen';
import { SetupScreen } from './screens/SetupScreen';
import { SettingsDialog } from './screens/SettingsDialog';
import { getLocale, translate, useI18n } from './i18n';
import { Gear, Shell, Stage, VeeMark } from './ui';

type Gate = 'loading' | 'setup' | 'expired' | 'auth' | 'chat';

/** The ticket is single use, so both StrictMode effect runs share one attempt. */
let redeemAttempt: Promise<string> | null = null;

function dashboardHref(apiUrl?: string): string {
  const origin = (apiUrl || 'https://vectoree.ai').replace(/\/$/, '');
  return `${origin}/dashboard`;
}

function redeemTicketOnce(ticket: string): Promise<string> {
  redeemAttempt ??= redeemPreview(ticket)
    .then(
      () => '',
      (err: unknown) => (err instanceof ApiError && err.code === PREVIEW_REQUIRED ? '' : err instanceof Error ? err.message : ''),
    )
    .finally(() => {
      const url = new URL(window.location.href);
      url.searchParams.delete('ticket');
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    });
  return redeemAttempt;
}

export function App() {
  const { t } = useI18n();
  const [gate, setGate] = useState<Gate>('loading');
  const [cloud, setCloud] = useState(false);
  const [projectName, setProjectName] = useState<string | undefined>();
  const [apiUrl, setApiUrl] = useState<string | undefined>();
  const [user, setUser] = useState<PublicUser | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    function onExpired() {
      setUser(null);
      setGate('expired');
    }
    window.addEventListener(PREVIEW_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(PREVIEW_EXPIRED_EVENT, onExpired);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let isCloud = false;
    (async () => {
      try {
        let status = await getSetupStatus();
        if (cancelled) return;
        if (status.mode === 'cloud') {
          isCloud = true;
          setCloud(true);
          const ticket = new URLSearchParams(window.location.search).get('ticket');
          if (ticket) {
            const redeemError = await redeemTicketOnce(ticket);
            if (cancelled) return;
            if (redeemError) setError(redeemError);
            status = await getSetupStatus();
            if (cancelled) return;
          }
          if (!status.previewed) {
            setGate('expired');
            return;
          }
          setProjectName(status.projectName);
          setApiUrl(status.apiUrl);
          const session = await getSession();
          if (cancelled) return;
          if (!session.user) {
            setGate('auth');
            return;
          }
          setUser(session.user);
          setGate('chat');
          return;
        }
        if (!status.linked) {
          setGate('setup');
          return;
        }
        setProjectName(status.projectName);
        setApiUrl(status.apiUrl);
        const session = await getSession();
        if (cancelled) return;
        if (!session.user) {
          setGate('auth');
          return;
        }
        setUser(session.user);
        setGate('chat');
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : translate(getLocale(), 'serverUnreachable'));
        setGate(isCloud ? 'expired' : 'setup');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (gate === 'loading') {
    return (
      <Shell>
        <main className="boot">
          <div className="boot-card" role="status" aria-live="polite">
            <VeeMark face="thinking" animated title={t('checkingLink')} />
            <p className="boot-caption">{t('checkingLink')}</p>
          </div>
        </main>
      </Shell>
    );
  }

  if (gate === 'expired') {
    return (
      <Shell>
        <Stage title={t('previewExpired')} gloss={t('previewGloss')} sticker="Vectoree">
          <div className="panel stack">
            <p className="note">{t('previewExpiredNote')}</p>
            {error ? <div className="error">{error}</div> : null}
          </div>
        </Stage>
      </Shell>
    );
  }

  if (gate === 'setup') {
    return (
      <Shell>
        {error ? (
          <div className="stage">
            <div className="error">{error}</div>
          </div>
        ) : null}
        <SetupScreen
          onLinked={() => {
            setError('');
            setGate('auth');
            void getSetupStatus().then((status) => {
              setProjectName(status.projectName);
            });
          }}
        />
      </Shell>
    );
  }

  if (gate === 'auth' || !user) {
    return (
      <AuthScreen
        templateName="vectoree starter"
        subtitle={t('authSubtitle')}
        returnHref={dashboardHref(apiUrl)}
        onSignedIn={(next) => {
          setUser(next);
          setGate('chat');
        }}
      />
    );
  }

  return (
    <SignedIn
      user={user}
      cloud={cloud}
      projectName={projectName}
      onSignedOut={() => {
        setUser(null);
        setGate('auth');
      }}
    />
  );
}

function SignedIn({
  user,
  cloud,
  projectName,
  onSignedOut,
}: {
  user: PublicUser;
  cloud: boolean;
  projectName?: string;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(() => {
    try {
      return localStorage.getItem('ve-starter-nav') !== 'closed';
    } catch {
      return true;
    }
  });
  const [models, setModels] = useState<ListedModel[]>([]);
  const [model, setModel] = useState('vectoree/auto');
  const [imageModel, setImageModel] = useState('');
  const [modelError, setModelError] = useState('');
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const skipRename = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void listConversations()
      .then(async (payload) => {
        if (cancelled) return;
        if (payload.conversations.length > 0) {
          setConversations(payload.conversations);
          setConversationId((current) =>
            current && payload.conversations.some((item) => item.id === current) ? current : payload.conversations[0].id,
          );
          setConversationError('');
          return;
        }
        const created = await createConversation(false);
        if (cancelled) return;
        setConversations([created]);
        setConversationId(created.id);
        setConversationError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setConversationError(err instanceof Error ? err.message : translate(getLocale(), 'loadChatFail'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((payload) => {
        if (cancelled) return;
        setModels(payload.models);
        setModel(payload.defaultModel || 'vectoree/auto');
        setImageModel(payload.imageModel || '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setModelError(err instanceof Error ? err.message : translate(getLocale(), 'loadModelsFail'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onNewChat() {
    setConversationError('');
    try {
      const created = await createConversation(true);
      setConversations((current) => [created, ...current.filter((item) => item.id !== created.id)]);
      setConversationId(created.id);
    } catch (err) {
      setConversationError(err instanceof Error ? err.message : translate(getLocale(), 'loadChatFail'));
    }
  }

  async function onDeleteChat(id: string) {
    if (!window.confirm(t('confirmDeleteChat'))) return;
    setConversationError('');
    try {
      await deleteConversation(id);
      const remaining = conversations.filter((item) => item.id !== id);
      if (remaining.length === 0) {
        const created = await createConversation(true);
        setConversations([created]);
        setConversationId(created.id);
        return;
      }
      setConversations(remaining);
      if (conversationId === id) setConversationId(remaining[0].id);
    } catch (err) {
      setConversationError(err instanceof Error ? err.message : translate(getLocale(), 'loadChatFail'));
    }
  }

  function onSaved(id: string) {
    const now = new Date().toISOString();
    setConversations((current) =>
      current
        .map((item) => (item.id === id ? { ...item, updatedAt: now } : item))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0)),
    );
  }

  function onTitled(id: string, title: string) {
    setConversations((current) =>
      current.map((item) => (item.id === id ? { ...item, title, titledByModel: true } : item)),
    );
  }

  function chatTitle(item: ConversationMeta): string {
    if (!item.titledByModel && (item.title === 'New chat' || !item.title)) return t('untitled');
    return item.title;
  }

  function startRename(item: ConversationMeta) {
    setConversationId(item.id);
    setEditingId(item.id);
    setDraftTitle(chatTitle(item));
  }

  async function commitRename(id: string) {
    if (skipRename.current) {
      skipRename.current = false;
      return;
    }
    const title = draftTitle.trim();
    const current = conversations.find((item) => item.id === id);
    setEditingId(null);
    if (!current || !title || title === chatTitle(current)) return;
    setConversationError('');
    try {
      const saved = await renameConversation(id, title);
      setConversations((list) =>
        list.map((item) =>
          item.id === id ? { ...item, title: saved.title, titledByModel: true, updatedAt: saved.updatedAt } : item,
        ),
      );
    } catch (err) {
      setConversationError(err instanceof Error ? err.message : translate(getLocale(), 'renameFail'));
    }
  }

  async function onLogout() {
    await logoutAccount();
    onSignedOut();
  }

  function toggleNav() {
    setNavOpen((open) => {
      const next = !open;
      try {
        localStorage.setItem('ve-starter-nav', next ? 'open' : 'closed');
      } catch {
        // private mode
      }
      return next;
    });
  }

  return (
    <Shell>
      <div className="workspace">
        <aside className={navOpen ? 'sidebar' : 'sidebar collapsed'}>
          <button className="btn side-new" type="button" aria-label={t('newChat')} onClick={() => void onNewChat()}>
            {navOpen ? t('newChat') : <PlusIcon />}
          </button>
          <div className="side-nav">
            {navOpen ? <p className="eyebrow side-label">{t('history')}</p> : null}
            {conversations.map((item) =>
              navOpen ? (
              <div key={item.id} className="side-convo">
                {editingId === item.id ? (
                  <input
                    className="side-rename"
                    value={draftTitle}
                    aria-label={chatTitle(item)}
                    autoFocus
                    onChange={(event) => setDraftTitle(event.target.value)}
                    onBlur={() => void commitRename(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        skipRename.current = true;
                        setEditingId(null);
                      }
                    }}
                  />
                ) : (
                  <button
                    className={item.id === conversationId ? 'side-chat active' : 'side-chat'}
                    type="button"
                    onClick={() => setConversationId(item.id)}
                    onDoubleClick={() => startRename(item)}
                  >
                    {chatTitle(item)}
                  </button>
                )}
                <button className="side-x" type="button" aria-label={t('delete')} onClick={() => void onDeleteChat(item.id)}>
                  <CloseGlyph />
                </button>
              </div>
              ) : (
                <button
                  key={item.id}
                  className={item.id === conversationId ? 'side-chat-icon active' : 'side-chat-icon'}
                  type="button"
                  aria-label={chatTitle(item)}
                  title={chatTitle(item)}
                  onClick={() => setConversationId(item.id)}
                >
                  <ChatMark />
                </button>
              ),
            )}
            {navOpen && conversationError ? <p className="note">{conversationError}</p> : null}
            {navOpen && modelError ? <p className="note">{modelError}</p> : null}
          </div>
          <div className="side-dock">
            <button
              className="side-fold"
              type="button"
              aria-label={navOpen ? t('collapseNav') : t('expandNav')}
              title={navOpen ? t('collapseNav') : t('expandNav')}
              onClick={toggleNav}
            >
              <PanelToggle open={navOpen} />
              {navOpen ? t('collapseNav') : null}
            </button>
            <UserChip
            navOpen={navOpen}
            email={user.email}
            projectName={projectName}
            onSettings={() => setSettingsOpen(true)}
            onLogout={() => void onLogout()}
            />
          </div>
        </aside>
        <div className="workspace-main">
          <ChatScreen
            conversationId={conversationId}
            titledByModel={Boolean(conversations.find((item) => item.id === conversationId)?.titledByModel)}
            models={models}
            model={model}
            imageModel={imageModel}
            onTitled={onTitled}
            onSaved={onSaved}
          />
        </div>
      </div>
      {settingsOpen ? (
        <SettingsDialog
          cloud={cloud}
          email={user.email}
          models={models}
          model={model}
          imageModel={imageModel}
          onModel={setModel}
          onImageModel={setImageModel}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
    </Shell>
  );
}

const DOCS_URL = 'https://docs.vectoree.ai/introduction';
const FEEDBACK_URL = 'https://vectoree.ai/dashboard/feedback';

function UserChip({
  navOpen,
  email,
  projectName,
  onSettings,
  onLogout,
}: {
  navOpen: boolean;
  email: string;
  projectName?: string;
  onSettings: () => void;
  onLogout: () => void;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ left: number; bottom: number; width: number } | null>(null);
  const title = projectName || email;
  const initial = (email.trim()[0] || title.trim()[0] || '?').toUpperCase();

  function place() {
    const node = rootRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setBox({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8,
      width: Math.max(rect.width, 208),
    });
  }

  useEffect(() => {
    if (!open) return;
    place();
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    function onLayout() {
      place();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onLayout);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onLayout);
    };
  }, [open, navOpen]);

  return (
    <div className="side-foot" ref={rootRef}>
      <button
        className="side-user"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('accountMenu')}
        title={email}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          place();
          setOpen(true);
        }}
      >
        <span className="side-avatar" aria-hidden="true">
          {initial}
        </span>
        {navOpen ? (
          <span className="side-user-copy">
            <span className="side-project-name">{title}</span>
            {projectName ? <span className="mono side-email">{email}</span> : null}
          </span>
        ) : null}
      </button>
      {open && box ? (
        <div className="side-menu" role="menu" style={{ left: box.left, bottom: box.bottom, width: box.width }}>
          <button
            className="side-menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSettings();
            }}
          >
            <Gear />
            {t('settings')}
          </button>
          <a className="side-menu-item" role="menuitem" href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            <BookIcon />
            {t('docs')}
          </a>
          <a className="side-menu-item" role="menuitem" href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">
            <FeedbackIcon />
            {t('feedback')}
          </a>
          <div className="side-menu-split" />
          <button
            className="side-menu-item"
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            <LogoutIcon />
            {t('logout')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 3.2c-1.5-.8-3.2-1-5.5-.6v9.3c2.3-.4 4-.2 5.5.6 1.5-.8 3.2-1 5.5-.6V2.6c-2.3-.4-4-.2-5.5.6z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M8 3.2v9.3" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function FeedbackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.2 2.8h11.6v7.2H6.1L2.2 13.1V2.8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChatMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.25" y="2.25" width="11.5" height="11.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 6.25h6M5 9.75h4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function PanelToggle({ open }: { open: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.8" />
      <path d={open ? 'M11 6 L9 8 L11 10' : 'M9 6 L11 8 L9 10'} fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 2.5H3.5v11H6" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 8h6.5M11 5.5L13.5 8 11 10.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path d="M2 2l9 9M11 2L2 11" fill="none" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}
