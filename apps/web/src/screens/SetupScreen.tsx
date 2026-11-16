import { useEffect, useRef, useState } from 'react';
import {
  exchangeConsoleCode,
  getConnect,
  linkProject,
  listConsoleProjects,
  pollConsoleDevice,
  startConnect,
  type ConsoleProject,
} from '../api';
import { useI18n } from '../i18n';
import { Stage } from '../ui';

type ProjectGroup = { key: string; id?: string; label?: string; projects: ConsoleProject[] };

function groupByOrganization(projects: ConsoleProject[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const item of projects) {
    const key = item.organizationId || item.organizationName || '';
    let group = groups.get(key);
    if (!group) {
      group = { key, id: item.organizationId, label: item.organizationName, projects: [] };
      groups.set(key, group);
    }
    group.projects.push(item);
  }
  return [...groups.values()];
}

type Phase = 'checking' | 'login' | 'redirecting' | 'device' | 'signingIn' | 'fetching' | 'choose' | 'linking' | 'done';

type LinkCheckMessage = { type?: string; token?: string; skipped?: boolean; error?: string };

const HOSTED_LINK_HOSTS = new Set(['vectoree.ai', 'www.vectoree.ai', 'vectoree.net', 'www.vectoree.net', 'vectoree.site']);
const RUNTIME_SITE_HOST = /^rt-[0-9a-f]{32}\.vectoree\.site$/;

function isHostedLinkPage(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  return HOSTED_LINK_HOSTS.has(host) || RUNTIME_SITE_HOST.test(host);
}

function waitForLinkCheck(popup: Window, fail: (message: string) => Error): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(() => reject(fail('timeout'))), 3 * 60 * 1000);
    const closePoll = window.setInterval(() => {
      if (popup.closed) finish(() => reject(fail('closed')));
    }, 400);
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin || event.source !== popup) return;
      const data = event.data as LinkCheckMessage;
      if (!data || data.type !== 'vectoree-link-turnstile') return;
      if (typeof data.token === 'string' && data.token) finish(() => resolve(data.token));
      else if (data.skipped) finish(() => resolve(undefined));
      else finish(() => reject(fail(data.error || 'fail')));
    }
    function finish(done: () => void) {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      window.clearInterval(closePoll);
      done();
    }
    window.addEventListener('message', onMessage);
  });
}

export function SetupScreen({ onLinked }: { onLinked: () => void }) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<Phase>('checking');
  const [apiUrl, setApiUrl] = useState('https://vectoree.ai');
  const [projects, setProjects] = useState<ConsoleProject[]>([]);
  const [selected, setSelected] = useState('');
  const [linkedName, setLinkedName] = useState('');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(3);
  const [userCode, setUserCode] = useState('');
  const [verificationUri, setVerificationUri] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(2);
  function explain(message: string | undefined, fallback: string): string {
    if (message === 'Log in to Vectoree first') return t('loginFirst');
    if (message === 'Console login timed out. Log in again.') return t('loginTimeout');
    if (message === 'No Console login to finish. Log in again.') return t('loginAgain');
    if (message?.includes('Connect from the forwarded address')) return t('loginOrigin');
    return message || fallback;
  }

  const resumed = useRef(false);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void getConnect()
      .then((status) => {
        if (status.apiUrl) setApiUrl(status.apiUrl);
        if (status.status === 'device' && status.userCode && status.verificationUri) {
          showDevice(status.userCode, status.verificationUri, status.intervalSeconds);
          return;
        }
        if (status.status === 'callback') return signIn();
        if (status.status === 'authorized') return fetchProjects();
        if (status.status === 'error') setError(explain(status.message, t('loginFail')));
        setPhase('login');
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : t('serverUnreachable'));
        setPhase('login');
      });
  }, []);

  useEffect(() => {
    if (phase !== 'done') return undefined;
    setSeconds(3);
    const tick = window.setInterval(() => {
      setSeconds((current) => (current > 1 ? current - 1 : 1));
    }, 1000);
    const timer = window.setTimeout(() => onLinkedRef.current(), 3000);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(timer);
    };
  }, [phase]);

  async function signIn() {
    setPhase('signingIn');
    setError('');
    try {
      await exchangeConsoleCode();
    } catch (err) {
      setError(explain(err instanceof Error ? err.message : undefined, t('loginFail')));
      setPhase('login');
      return;
    }
    await fetchProjects();
  }

  async function fetchProjects() {
    setPhase('fetching');
    setError('');
    try {
      const payload = await listConsoleProjects();
      setProjects(payload.projects);
      setSelected((current) =>
        payload.projects.some((item) => item.id === current) ? current : payload.projects[0]?.id ?? '',
      );
      setPhase('choose');
    } catch (err) {
      setError(explain(err instanceof Error ? err.message : undefined, t('listProjectsFail')));
      setPhase('login');
    }
  }

  function showDevice(code: string, uri: string, interval: number | undefined) {
    setUserCode(code);
    setVerificationUri(uri);
    setIntervalSeconds(interval && interval >= 1 ? interval : 2);
    setPhase('device');
  }

  useEffect(() => {
    if (phase !== 'device') return undefined;
    let stopped = false;
    let timer = 0;
    const wait = Math.max(2, intervalSeconds) * 1000;
    const tick = async () => {
      try {
        const status = await pollConsoleDevice();
        if (stopped) return;
        if (status.status === 'authorized') {
          await fetchProjects();
          return;
        }
        if (status.status === 'error') {
          setError(explain(status.message, t('loginFail')));
          setPhase('login');
          return;
        }
        setError('');
        if (status.userCode) setUserCode(status.userCode);
        if (status.verificationUri) setVerificationUri(status.verificationUri);
      } catch (err) {
        if (!stopped) setError(explain(err instanceof Error ? err.message : undefined, t('loginFail')));
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), wait);
    };
    timer = window.setTimeout(() => void tick(), wait);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [phase, intervalSeconds]);

  async function onLogin() {
    setPhase('redirecting');
    setError('');
    try {
      const status = await startConnect({
        apiUrl,
        openBrowser: false,
        redirectOrigin: new URL(import.meta.env.BASE_URL, window.location.origin).href,
      });
      if (status.status === 'device' && status.userCode && status.verificationUri) {
        showDevice(status.userCode, status.verificationUri, status.intervalSeconds);
        return;
      }
      if (!status.authorizeUrl) throw new Error(status.message || t('loginFail'));
      window.location.assign(status.authorizeUrl);
    } catch (err) {
      setError(explain(err instanceof Error ? err.message : undefined, t('loginFail')));
      setPhase('login');
    }
  }

  async function onLink() {
    if (!selected) return;
    const page = new URL('link-check.html', new URL(import.meta.env.BASE_URL, window.location.origin));
    page.searchParams.set('lang', locale.startsWith('zh') ? 'zh' : 'en');
    const popup = window.open(page.href, 'vectoree-link-check', 'popup,width=440,height=560');
    if (!popup) {
      setError(t('popupBlocked'));
      return;
    }
    setPhase('linking');
    setError('');
    try {
      const token = await waitForLinkCheck(popup, (kind) => {
        if (kind === 'timeout') return new Error(t('linkCheckTimeout'));
        if (kind === 'closed') return new Error(t('linkCheckClosed'));
        return new Error(kind === 'fail' ? t('linkCheckFail') : kind);
      });
      const status = await linkProject(selected, token, isHostedLinkPage(window.location.hostname));
      const project = projects.find((item) => item.id === selected);
      const name = status.projectName || project?.name || selected;
      setLinkedName(project?.organizationName ? `${project.organizationName} / ${name}` : name);
      setPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('connectFail'));
      setPhase('choose');
    }
  }

  const errorBox = error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : null;

  if (phase === 'done') {
    return (
      <Stage title={t('linkDone')} gloss={t('setupGloss')} sticker={t('consoleLogin')}>
        <div className="panel link-done">
          <p className="note">{t('linkedProject', { name: linkedName })}</p>
          <div className="link-count" aria-live="polite">
            {seconds}
          </div>
          <div className="link-meter" aria-hidden="true">
            <span />
          </div>
          <p className="note">{t('linkDoneNote')}</p>
        </div>
      </Stage>
    );
  }

  if (phase === 'checking' || phase === 'signingIn' || phase === 'fetching') {
    const title = phase === 'checking' ? t('checkingLink') : phase === 'signingIn' ? t('signingIn') : t('fetchingProjects');
    const note = phase === 'signingIn' ? t('signingInNote') : phase === 'fetching' ? t('fetchingProjectsNote') : '';
    return (
      <Stage title={title} gloss={t('setupGloss')} sticker={t('consoleLogin')}>
        <div className="panel stack" aria-live="polite">
          <p className="note">{note || t('working')}</p>
        </div>
      </Stage>
    );
  }

  if (phase === 'choose' || phase === 'linking') {
    const busy = phase === 'linking';
    return (
      <Stage title={t('chooseProject')} gloss={t('setupGloss')} sticker={t('consoleLogin')}>
        <div className="panel stack">
          <p className="note">{t('chooseProjectNote')}</p>
          {projects.length === 0 ? (
            <p className="note">{t('noProjects')}</p>
          ) : (
            <div className="project-list" role="radiogroup" aria-label={t('chooseProject')}>
              {groupByOrganization(projects).map((group) => {
                const title = group.label ?? (group.id ? t('organizationId', { id: group.id }) : t('noOrganization'));
                return (
                  <section key={group.key} className="project-group" aria-label={title}>
                    <p className="eyebrow">{title}</p>
                    {group.projects.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        aria-checked={item.id === selected}
                        className={item.id === selected ? 'project-option active' : 'project-option'}
                        onClick={() => setSelected(item.id)}
                        disabled={busy}
                      >
                        <span className="project-name">{item.name}</span>
                        <span className="mono">{item.id}</span>
                      </button>
                    ))}
                  </section>
                );
              })}
            </div>
          )}
          {errorBox}
          <div className="row">
            <button className="btn as-typed" type="button" onClick={() => void onLink()} disabled={busy || !selected}>
              {busy ? t('linking') : t('linkBtn')}
            </button>
            <button className="btn-ghost as-typed" type="button" onClick={() => void fetchProjects()} disabled={busy}>
              {t('refresh')}
            </button>
            <button className="btn-ghost as-typed" type="button" onClick={() => void onLogin()} disabled={busy}>
              {t('switchAccount')}
            </button>
          </div>
        </div>
      </Stage>
    );
  }

  if (phase === 'device') {
    return (
      <Stage title={t('linkProject')} gloss={t('setupGloss')} sticker={t('consoleLogin')}>
        <div className="panel stack">
          <p className="note">{t('deviceNote')}</p>
          <p className="device-code">{userCode}</p>
          {errorBox}
          <p className="note">{t('deviceWaiting')}</p>
          <div className="row">
            <a className="btn as-typed" href={verificationUri} target="_blank" rel="noreferrer">
              {t('deviceOpen')}
            </a>
          </div>
        </div>
      </Stage>
    );
  }

  const redirecting = phase === 'redirecting';
  return (
    <Stage title={t('linkProject')} gloss={t('setupGloss')} sticker={t('consoleLogin')}>
      <div className="panel stack">
        <p className="note">{t('setupNote')}</p>
        <label className="field-label">
          <span className="eyebrow">{t('apiOrigin')}</span>
          <input
            className="field"
            value={apiUrl}
            onChange={(event) => setApiUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>
        {errorBox}
        <div className="row">
          <button className="btn as-typed" type="button" onClick={() => void onLogin()} disabled={redirecting}>
            {redirecting ? t('redirecting') : t('loginVectoree')}
          </button>
        </div>
      </div>
    </Stage>
  );
}
