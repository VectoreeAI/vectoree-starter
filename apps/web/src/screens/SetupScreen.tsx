import { useEffect, useRef, useState } from 'react';
import {
  exchangeConsoleCode,
  getConnect,
  linkProject,
  listConsoleProjects,
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

type Phase = 'checking' | 'login' | 'redirecting' | 'signingIn' | 'fetching' | 'choose' | 'linking' | 'done';

export function SetupScreen({ onLinked }: { onLinked: () => void }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>('checking');
  const [apiUrl, setApiUrl] = useState('https://vectoree.ai');
  const [projects, setProjects] = useState<ConsoleProject[]>([]);
  const [selected, setSelected] = useState('');
  const [linkedName, setLinkedName] = useState('');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(3);
  const resumed = useRef(false);
  const onLinkedRef = useRef(onLinked);
  onLinkedRef.current = onLinked;

  useEffect(() => {
    if (resumed.current) return;
    resumed.current = true;
    void getConnect()
      .then((status) => {
        if (status.apiUrl) setApiUrl(status.apiUrl);
        if (status.status === 'callback') return signIn();
        if (status.status === 'authorized') return fetchProjects();
        if (status.status === 'error') setError(status.message || t('loginFail'));
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
      setError(err instanceof Error ? err.message : t('loginFail'));
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
      setError(err instanceof Error ? err.message : t('listProjectsFail'));
      setPhase('login');
    }
  }

  async function onLogin() {
    setPhase('redirecting');
    setError('');
    try {
      const status = await startConnect({
        apiUrl,
        openBrowser: false,
        redirectOrigin: new URL(import.meta.env.BASE_URL, window.location.origin).href,
      });
      if (!status.authorizeUrl) throw new Error(status.message || t('loginFail'));
      window.location.assign(status.authorizeUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loginFail'));
      setPhase('login');
    }
  }

  async function onLink() {
    if (!selected) return;
    setPhase('linking');
    setError('');
    try {
      const status = await linkProject(selected);
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
