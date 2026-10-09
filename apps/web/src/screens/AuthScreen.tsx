import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { resendCode, startEmailAuth, verifyEmail, type EmailStartResult, type PublicUser } from '../api';
import { useI18n } from '../i18n';
import { LocaleSwitch, VectoreeLockup } from '../ui';

const CODE_WAIT_MS = 60_000;
const CODE_LENGTH = 8;

type Step = 'email' | 'code';

export function AuthScreen({
  templateName,
  subtitle,
  returnHref,
  onSignedIn,
}: {
  templateName: string;
  subtitle: string;
  returnHref: string;
  onSignedIn: (user: PublicUser) => void;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeInputs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    if (step !== 'code') return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const resendWait = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const codeReady = otp.length === CODE_LENGTH;

  useEffect(() => {
    if (step !== 'code') return;
    codeInputs.current[0]?.focus();
  }, [step]);

  function focusCode(index: number) {
    codeInputs.current[index]?.focus();
  }

  function writeCode(next: string, focusIndex: number) {
    const digits = next.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setOtp(digits);
    focusCode(Math.min(focusIndex, CODE_LENGTH - 1));
  }

  function onCodeChange(index: number, value: string) {
    const digits = value.replace(/\D/g, '');
    if (digits.length > 1) {
      writeCode(otp.slice(0, index) + digits, index + digits.length);
      return;
    }
    const chars = Array.from({ length: CODE_LENGTH }, (_, i) => otp[i] ?? '');
    chars[index] = digits;
    writeCode(chars.join(''), digits ? index + 1 : index);
  }

  function onCodeKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !otp[index] && index > 0) {
      event.preventDefault();
      const chars = otp.split('');
      chars.splice(index - 1, 1);
      writeCode(chars.join(''), index - 1);
      return;
    }
    if (event.key === 'ArrowLeft' && index > 0) focusCode(index - 1);
    if (event.key === 'ArrowRight' && index < CODE_LENGTH - 1) focusCode(index + 1);
  }

  function showCodeStep() {
    setStep('code');
    setOtp('');
    setError('');
    setNotice('');
    setResendAt(Date.now() + CODE_WAIT_MS);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const address = email.trim();
    if (!address) return;
    if (step === 'code' && otp.length !== CODE_LENGTH) return;
    setPending(true);
    try {
      if (step === 'email') {
        const result = await startEmailAuth(address);
        if (isSignedIn(result)) {
          onSignedIn(result.user);
          return;
        }
        if (isCodeStep(result)) {
          showCodeStep();
          return;
        }
        setError(result.message || t('authFail'));
        return;
      }
      if (step === 'code') {
        const result = await verifyEmail({ email: address, otp });
        if (result.user) onSignedIn(result.user);
        else setError(result.message || t('verifyFail'));
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('authFail'));
    } finally {
      setPending(false);
    }
  }

  async function onResend() {
    if (resendWait > 0) return;
    setError('');
    setNotice('');
    setPending(true);
    try {
      await resendCode(email.trim());
      setNotice(t('resentOk'));
      setResendAt(Date.now() + CODE_WAIT_MS);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('resendFail'));
    } finally {
      setPending(false);
    }
  }

  const stepTitle = step === 'code' ? t('checkEmail') : '';

  return (
    <div className="auth-page">
      <div className="auth-toolbar">
        <LocaleSwitch />
      </div>
      <div className="auth-stack">
        <header className="auth-intro">
          <h1 className="auth-title">{t('authTitle', { name: templateName })}</h1>
          <p className="auth-hint">{t('authAutoCreate')}</p>
        </header>
        <main className={step === 'code' ? 'auth-card is-code' : 'auth-card'}>
        {stepTitle ? <h2 className="auth-step-title">{stepTitle}</h2> : null}
        {step === 'code' ? <p className="auth-code-lead">{t('codeSentLead')}</p> : null}
        {step === 'code' ? (
          <div className="auth-email-row">
            <span className="auth-email-text">{email}</span>
            <button type="button" className="auth-edit" aria-label={t('editEmail')} onClick={() => setStep('email')}>
              <Pencil />
            </button>
          </div>
        ) : null}
        <form className={step === 'code' ? 'auth-form is-code' : 'auth-form'} onSubmit={onSubmit}>
          {step === 'email' ? (
            <label className="field-label">
              <span className="eyebrow">{t('email')}</span>
              <input
                className="field"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                autoFocus
                required
              />
            </label>
          ) : null}
          {step === 'code' ? (
            <div className="otp-row" onPaste={(event) => {
              const text = event.clipboardData.getData('text');
              if (!/\d/.test(text)) return;
              event.preventDefault();
              writeCode(text, CODE_LENGTH);
            }}>
              {Array.from({ length: CODE_LENGTH }, (_, index) => (
                <input
                  key={index}
                  ref={(node) => {
                    codeInputs.current[index] = node;
                  }}
                  className="otp-cell"
                  inputMode="numeric"
                  autoComplete={index === 0 ? 'one-time-code' : 'off'}
                  aria-label={`${t('code')} ${index + 1}`}
                  maxLength={index === 0 ? CODE_LENGTH : 1}
                  value={otp[index] ?? ''}
                  onChange={(event) => onCodeChange(index, event.target.value)}
                  onKeyDown={(event) => onCodeKeyDown(index, event)}
                />
              ))}
            </div>
          ) : null}
          {step === 'code' ? (
            resendWait > 0 ? (
              <p className="auth-resend">{t('resendWait', { seconds: resendWait })}</p>
            ) : (
              <button type="button" className="auth-resend-link" onClick={() => void onResend()} disabled={pending}>
                {t('resendReady')}
              </button>
            )
          ) : null}
          {error ? (
            <div className="error" role="alert">
              {walletNotActivated(error) ? (
                <p>
                  {t('walletActivateBefore')}
                  <a href={billingHref(returnHref)}>{t('walletActivateLink')}</a>
                  {t('walletActivateAfter')}
                </p>
              ) : (
                <p>{error}</p>
              )}
            </div>
          ) : null}
          {notice && step !== 'code' ? <p className="auth-notice">{notice}</p> : null}
          {step === 'code' ? <p className="auth-callout">{t('codeSentBox')}</p> : null}
          <button
            className={step === 'code' ? 'btn auth-submit auth-continue' : 'btn auth-submit'}
            type="submit"
            disabled={pending || (step === 'code' && !codeReady)}
          >
            {pending ? t('working') : step === 'code' ? `${t('continueBtn')} →` : t('continueBtn')}
          </button>
        </form>
        {step === 'email' ? (
          <div className="auth-alt">
            <a className="auth-back" href={returnHref} aria-label={t('backToDashboard')}>
              <ArrowLeft />
              <span>{t('dashboardName')}</span>
            </a>
          </div>
        ) : null}
        {step !== 'code' ? (
          <footer className="auth-provider">
            <VectoreeLockup />
          </footer>
        ) : null}
        </main>
        <p className="auth-lead">{subtitle}</p>
      </div>
    </div>
  );
}

function Pencil() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z" fill="none" stroke="currentColor" strokeWidth="2.2" />
      <path d="M13.2 7.2l3.6 3.6" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  );
}

function ArrowLeft() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 12H6M11 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square" />
    </svg>
  );
}

function billingHref(dashboardHref: string): string {
  return `${dashboardHref.replace(/\/$/, '')}/organization/billing`;
}

function walletNotActivated(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('wallet is not activated') || text.includes('billing_wallet_not_activated');
}

function isSignedIn(result: EmailStartResult): result is { next: 'signed-in'; user: PublicUser } {
  return 'next' in result && result.next === 'signed-in';
}

function isCodeStep(result: EmailStartResult): result is { next: 'code' } {
  return 'next' in result && result.next === 'code';
}
