import { useEffect, useRef, useState } from 'react';
import {
  createConversation,
  deleteConversation,
  renameConversation,
  getBuckets,
  getModels,
  getSession,
  getSetupStatus,
  getTables,
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
import { DatabaseScreen } from './screens/DatabaseScreen';
import { SetupScreen } from './screens/SetupScreen';
import { SettingsDialog } from './screens/SettingsDialog';
import { StorageScreen } from './screens/StorageScreen';
import { getLocale, translate, useI18n } from './i18n';
import { Gear, Shell, Stage } from './ui';

type Gate = 'loading' | 'setup' | 'expired' | 'auth' | 'chat';

/** The ticket is single use, so both StrictMode effect runs share one attempt. */
let redeemAttempt: Promise<string> | null = null;

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
  const [projectId, setProjectId] = useState<string | undefined>();
  const [projectName, setProjectName] = useState<string | undefined>();
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
          setProjectId(status.projectId);
          setProjectName(status.projectName);
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
        setProjectId(status.projectId);
        setProjectName(status.projectName);
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
        <main className="stage">
          <p className="eyebrow">{t('boot')}</p>
          <h1 className="display">{t('checkingLink')}</h1>
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
              setProjectId(status.projectId);
              setProjectName(status.projectName);
            });
          }}
        />
      </Shell>
    );
  }

  if (gate === 'auth' || !user) {
    return (
      <Shell>
        <AuthScreen
          onSignedIn={(next) => {
            setUser(next);
            setGate('chat');
          }}
        />
      </Shell>
    );
  }

  return (
    <SignedIn
      user={user}
      cloud={cloud}
      projectLabel={projectName || projectId}
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
  projectLabel,
  onSignedOut,
}: {
  user: PublicUser;
  cloud: boolean;
  projectLabel?: string;
  onSignedOut: () => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<'chat' | 'database' | 'storage'>('chat');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [models, setModels] = useState<ListedModel[]>([]);
  const [model, setModel] = useState('vectoree/auto');
  const [imageModel, setImageModel] = useState('');
  const [modelError, setModelError] = useState('');
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState<string | null>(null);
  const [tablesReady, setTablesReady] = useState(false);
  const [tableError, setTableError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const [buckets, setBuckets] = useState<string[]>([]);
  const [bucket, setBucket] = useState<string | null>(null);
  const [bucketsReady, setBucketsReady] = useState(false);
  const [bucketError, setBucketError] = useState('');
  const [storageReload, setStorageReload] = useState(0);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const skipRename = useRef(false);

  useEffect(() => {
    if (view !== 'database') return undefined;
    let cancelled = false;
    setTablesReady(false);
    void getTables()
      .then((payload) => {
        if (cancelled) return;
        setTables(payload.tables);
        setTable((current) => (current && payload.tables.includes(current) ? current : payload.tables[0] ?? null));
        setTableError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setTableError(err instanceof Error ? err.message : translate(getLocale(), 'listTablesFail'));
      })
      .finally(() => {
        if (!cancelled) setTablesReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [view, reloadToken]);

  useEffect(() => {
    if (view !== 'storage') return undefined;
    let cancelled = false;
    setBucketsReady(false);
    void getBuckets()
      .then((payload) => {
        if (cancelled) return;
        const names = payload.buckets.map((item) => item.name);
        setBuckets(names);
        setBucket((current) => (current && names.includes(current) ? current : names[0] ?? null));
        setBucketError('');
      })
      .catch((err: unknown) => {
        if (!cancelled) setBucketError(err instanceof Error ? err.message : translate(getLocale(), 'listBucketsFail'));
      })
      .finally(() => {
        if (!cancelled) setBucketsReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [view, storageReload]);

  useEffect(() => {
    if (view !== 'chat') return undefined;
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
  }, [view]);

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
      setView('chat');
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

  return (
    <Shell>
      <div className="workspace">
        <aside className="sidebar">
          <div className="side-nav">
          <p className="eyebrow">{t('app')}</p>
          <button className={view === 'chat' ? 'nav-btn active' : 'nav-btn'} type="button" onClick={() => void onNewChat()}>
            {t('newChat')}
          </button>
          <button
            className={view === 'database' ? 'nav-btn active' : 'nav-btn'}
            type="button"
            onClick={() => setView('database')}
          >
            {t('database')}
          </button>
          <button
            className={view === 'storage' ? 'nav-btn active' : 'nav-btn'}
            type="button"
            onClick={() => setView('storage')}
          >
            {t('storage')}
          </button>
          <hr className="side-divider" />
          {view === 'chat'
            ? conversations.map((item) => (
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
                      className={item.id === conversationId ? 'side-table active' : 'side-table'}
                      type="button"
                      onClick={() => setConversationId(item.id)}
                      onDoubleClick={() => startRename(item)}
                    >
                      {chatTitle(item)}
                    </button>
                  )}
                  <button className="side-x" type="button" aria-label={t('delete')} onClick={() => void onDeleteChat(item.id)}>
                    ×
                  </button>
                </div>
              ))
            : null}
          {view === 'database'
            ? tables.map((name) => (
                <button
                  key={name}
                  className={name === table ? 'side-table active' : 'side-table'}
                  type="button"
                  onClick={() => setTable(name)}
                >
                  {name}
                </button>
              ))
            : null}
          {view === 'storage'
            ? buckets.map((name) => (
                <button
                  key={name}
                  className={name === bucket ? 'side-table active' : 'side-table'}
                  type="button"
                  onClick={() => setBucket(name)}
                >
                  {name}
                </button>
              ))
            : null}
          {view === 'chat' && conversationError ? <p className="note">{conversationError}</p> : null}
          {view === 'database' && tableError ? <p className="note">{tableError}</p> : null}
          {view === 'storage' && bucketError ? <p className="note">{bucketError}</p> : null}
          {modelError ? <p className="note">{modelError}</p> : null}
          </div>
          <div className="side-foot">
            <button className="nav-btn with-icon" type="button" onClick={() => setSettingsOpen(true)}>
              <Gear />
              {t('settings')}
            </button>
            <div className="side-account">
              <p className="mono">{projectLabel || t('linked')}</p>
              <p className="mono">{user.email}</p>
              <button className="btn" type="button" onClick={() => void onLogout()}>
                {t('logout')}
              </button>
            </div>
          </div>
        </aside>
        <div className="workspace-main">
          {view === 'chat' ? (
            <ChatScreen
              conversationId={conversationId}
              titledByModel={Boolean(conversations.find((item) => item.id === conversationId)?.titledByModel)}
              models={models}
              model={model}
              imageModel={imageModel}
              onDatabase={() => setReloadToken((current) => current + 1)}
              onStorage={() => setStorageReload((current) => current + 1)}
              onTitled={onTitled}
              onSaved={onSaved}
            />
          ) : view === 'database' ? (
            <DatabaseScreen table={table} ready={tablesReady} reloadToken={reloadToken} />
          ) : (
            <StorageScreen
              bucket={bucket}
              ready={bucketsReady}
              reloadToken={storageReload}
              onChanged={() => setStorageReload((current) => current + 1)}
            />
          )}
        </div>
      </div>
      {settingsOpen ? (
        <SettingsDialog
          cloud={cloud}
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
