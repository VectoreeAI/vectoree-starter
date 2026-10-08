import { useEffect, useState, type FormEvent } from 'react';
import { getAuthMethods, loginAccount, registerAccount, resendCode, verifyEmail, type PublicUser } from '../api';
import { useI18n } from '../i18n';
import { Stage } from '../ui';

type Mode = 'login' | 'signup';

export function AuthScreen({ onSignedIn }: { onSignedIn: (user: PublicUser) => void }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [otp, setOtp] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [method, setMethod] = useState('code');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAuthMethods()
      .then((methods) => {
        if (!cancelled && methods.verifyEmailMethod) setMethod(methods.verifyEmailMethod);
      })
      .catch(() => {
        // The form still works if methods cannot be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      if (needsCode) {
        const result = await verifyEmail({ email, otp });
        if (result.user) onSignedIn(result.user);
        else setError(result.message || t('verifyFail'));
        return;
      }
      const result =
        mode === 'signup'
          ? await registerAccount({ email, password, name: name || undefined })
          : await loginAccount({ email, password });
      if (result.user) {
        onSignedIn(result.user);
        return;
      }
      if (result.requireEmailVerification) {
        setNeedsCode(true);
        return;
      }
      setError(result.message || t('signInFail'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authFail'));
    } finally {
      setPending(false);
    }
  }

  async function onResend() {
    setError('');
    setPending(true);
    try {
      await resendCode(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('resendFail'));
    } finally {
      setPending(false);
    }
  }

  return (
    <Stage
      title={needsCode ? t('checkEmail') : mode === 'signup' ? t('createAccount') : t('signIn')}
      gloss={t('authGloss')}
      sticker={t('authSticker')}
    >
      <form className="panel stack" onSubmit={onSubmit}>
        {needsCode ? (
          <>
            <p className="note">
              {method === 'link' ? t('linkNote') : t('codeNote', { email })}
            </p>
            {method !== 'link' ? (
              <label className="field-label">
                <span className="eyebrow">{t('code')}</span>
                <input
                  className="field"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={8}
                  value={otp}
                  onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 8))}
                  required
                />
              </label>
            ) : null}
          </>
        ) : (
          <>
            <div className="tabs">
              <button
                type="button"
                className={mode === 'signup' ? 'tab active' : 'tab'}
                onClick={() => {
                  setMode('signup');
                  setError('');
                }}
              >
                {t('signUp')}
              </button>
              <button
                type="button"
                className={mode === 'login' ? 'tab active' : 'tab'}
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
              >
                {t('signIn')}
              </button>
            </div>
            {mode === 'signup' ? (
              <label className="field-label">
                <span className="eyebrow">{t('name')}</span>
                <input className="field" value={name} onChange={(event) => setName(event.target.value)} />
              </label>
            ) : null}
            <label className="field-label">
              <span className="eyebrow">{t('email')}</span>
              <input
                className="field"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="field-label">
              <span className="eyebrow">{t('password')}</span>
              <input
                className="field"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                required
              />
            </label>
          </>
        )}
        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          {method === 'link' && needsCode ? (
            <button
              className="btn"
              type="button"
              onClick={() => {
                setNeedsCode(false);
                setMode('login');
              }}
            >
              {t('backSignIn')}
            </button>
          ) : (
            <button className="btn" type="submit" disabled={pending}>
              {pending ? t('working') : needsCode ? t('verify') : mode === 'signup' ? t('createAccountBtn') : t('signInBtn')}
            </button>
          )}
          {needsCode && method !== 'link' ? (
            <button className="btn-ghost" type="button" onClick={onResend} disabled={pending}>
              {t('resend')}
            </button>
          ) : null}
        </div>
      </form>
    </Stage>
  );
}
