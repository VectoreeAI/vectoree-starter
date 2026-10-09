import { useEffect, useState, type FormEvent } from 'react';
import { getSettings, saveSettings, setAccountPassword, type ListedModel } from '../api';
import { useI18n } from '../i18n';

export function SettingsDialog({
  cloud,
  email,
  models,
  model,
  imageModel,
  onModel,
  onImageModel,
  onClose,
}: {
  /** Cloud previews keep the project key on the server, so there is nothing to edit here. */
  cloud: boolean;
  email: string;
  models: ListedModel[];
  model: string;
  imageModel: string;
  onModel: (id: string) => void;
  onImageModel: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'model' | 'account'>('model');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chatModels = models.filter((item) => item.chat);
  const imageModels = models.filter((item) => item.imageOutput);

  useEffect(() => {
    if (cloud) return undefined;
    let cancelled = false;
    void getSettings()
      .then((payload) => {
        if (cancelled) return;
        setApiUrl(payload.apiUrl);
        setApiKey(payload.apiKey);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : t('loadSettingsFail'));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function onSave() {
    setBusy(true);
    setError('');
    try {
      const saved = await saveSettings({ apiUrl, apiKey });
      setApiUrl(saved.apiUrl);
      setApiKey(saved.apiKey);
      setReveal(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('saveSettingsFail'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-back" role="presentation" onClick={onClose}>
      <div
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="dialog-head">
          <div>
            <p className="eyebrow">{t('settings')}</p>
            <h2 id="settings-title" className="panel-title">
              {tab === 'account' ? t('account') : t('model')}
            </h2>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label={t('close')}>
            <CloseMark />
          </button>
        </header>
        <div className="settings-tabs" role="tablist" aria-label={t('settings')}>
          <button
            className="settings-tab"
            type="button"
            role="tab"
            id="settings-tab-model"
            aria-selected={tab === 'model'}
            aria-controls="settings-panel-model"
            onClick={() => setTab('model')}
          >
            {t('model')}
          </button>
          <button
            className="settings-tab"
            type="button"
            role="tab"
            id="settings-tab-account"
            aria-selected={tab === 'account'}
            aria-controls="settings-panel-account"
            onClick={() => setTab('account')}
          >
            {t('account')}
          </button>
        </div>
        {tab === 'account' ? (
          <div id="settings-panel-account" role="tabpanel" aria-labelledby="settings-tab-account">
            <AccountPanel email={email} />
          </div>
        ) : (
          <div id="settings-panel-model" role="tabpanel" aria-labelledby="settings-tab-model" className="settings-panel">
            {cloud ? null : (
              <>
                <p className="note">{t('modelConfig')}</p>
                <label className="field-label">
                  <span className="eyebrow">{t('baseUrl')}</span>
                  <input className="field" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} autoComplete="off" />
                </label>
                <label className="field-label">
                  <span className="eyebrow">{t('apiKey')}</span>
                  <span className="key-row">
                    <input
                      className="field"
                      type={reveal ? 'text' : 'password'}
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <button
                      className="btn-ghost eye"
                      type="button"
                      aria-label={reveal ? t('hideKey') : t('showKey')}
                      aria-pressed={reveal}
                      onClick={() => setReveal((current) => !current)}
                    >
                      <Eye open={reveal} />
                    </button>
                  </span>
                </label>
              </>
            )}
            <label className="field-label" htmlFor="settings-chat-model">
              <span className="eyebrow">{t('chatModel')}</span>
              <select
                id="settings-chat-model"
                className="select"
                value={model}
                onChange={(event) => onModel(event.target.value)}
              >
                {chatModels.length === 0 ? <option value={model}>{model}</option> : null}
                {chatModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.vision ? `${item.id} · ${t('visionTag')}` : item.id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-label" htmlFor="settings-image-model">
              <span className="eyebrow">{t('imageModel')}</span>
              <select
                id="settings-image-model"
                className="select"
                value={imageModel}
                disabled={imageModels.length === 0}
                onChange={(event) => onImageModel(event.target.value)}
              >
                {imageModel ? null : <option value="">{t('noImageOption')}</option>}
                {imageModels.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
              </select>
            </label>
            {error ? <div className="error">{error}</div> : null}
            {cloud ? null : (
              <button className="btn" type="button" disabled={busy || !apiUrl || !apiKey} onClick={() => void onSave()}>
                {busy ? t('saving') : t('saveLink')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AccountPanel({ email }: { email: string }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  function validatePassword(): boolean {
    if (password.length < 8) {
      setError(t('passwordTooShort'));
      return false;
    }
    if (password !== confirmPassword) {
      setError(t('passwordMismatch'));
      return false;
    }
    return true;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!validatePassword()) return;
    if (awaitingCode && code.trim().length !== 6) return;
    setBusy(true);
    try {
      const result = await setAccountPassword({
        password,
        confirmPassword,
        ...(awaitingCode ? { code: code.trim() } : {}),
      });
      if ('next' in result && result.next === 'code') {
        setAwaitingCode(true);
        setNotice(t('passwordCodeSent'));
        return;
      }
      setPassword('');
      setConfirmPassword('');
      setCode('');
      setAwaitingCode(false);
      setNotice(t('passwordSaved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('passwordSaveFail'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="account-panel" onSubmit={(event) => void onSubmit(event)}>
      <div className="account-row">
        <div>
          <p className="account-label">{t('email')}</p>
          <p className="note">{t('accountEmailHint')}</p>
        </div>
        <p className="account-email">{email}</p>
      </div>
      <div className="account-row">
        <p className="account-label">{t('accountSetPassword')}</p>
        <div className="account-fields">
          <label className="field-label">
            <span className="sr-only">{t('password')}</span>
            <input
              className="field"
              type="password"
              autoComplete="new-password"
              placeholder={t('password')}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <label className="field-label">
            <span className="sr-only">{t('confirmPassword')}</span>
            <input
              className="field"
              type="password"
              autoComplete="new-password"
              placeholder={t('confirmPassword')}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
          </label>
          {awaitingCode ? (
            <label className="field-label">
              <span className="sr-only">{t('passwordCode')}</span>
              <input
                className="field"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder={t('passwordCode')}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </label>
          ) : null}
          <div className="account-save">
            <button className="btn" type="submit" disabled={busy || !password || !confirmPassword || (awaitingCode && code.length !== 6)}>
              {busy ? t('saving') : t('save')}
            </button>
          </div>
        </div>
      </div>
      {error ? (
        <div className="error" role="alert">
          {error}
        </div>
      ) : null}
      {notice ? <p className="auth-notice">{notice}</p> : null}
    </form>
  );
}

function CloseMark() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
      <path d="M2 2l9 9M11 2L2 11" fill="none" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}

function Eye({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <rect x="1" y="6" width="16" height="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <rect x="7" y="7" width="4" height="4" fill="currentColor" />
      {open ? null : <rect x="2" y="8" width="14" height="2" fill="currentColor" />}
    </svg>
  );
}
