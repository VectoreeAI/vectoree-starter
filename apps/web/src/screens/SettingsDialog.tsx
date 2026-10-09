import { useEffect, useState } from 'react';
import { getSettings, saveSettings, type ListedModel } from '../api';
import { useI18n } from '../i18n';

export function SettingsDialog({
  cloud,
  models,
  model,
  imageModel,
  onModel,
  onImageModel,
  onClose,
}: {
  /** Cloud previews keep the project key on the server, so there is nothing to edit here. */
  cloud: boolean;
  models: ListedModel[];
  model: string;
  imageModel: string;
  onModel: (id: string) => void;
  onImageModel: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
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
        <div className="row">
          <div>
            <p className="eyebrow">{t('settings')}</p>
            <h2 id="settings-title" className="db-title">
              {t('model')}
            </h2>
          </div>
          <button className="btn-ghost" type="button" onClick={onClose}>
            {t('close')}
          </button>
        </div>
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
    </div>
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
