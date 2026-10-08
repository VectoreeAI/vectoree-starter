import type { ReactNode } from 'react';
import { useI18n, type Locale } from './i18n';

export function Shell({
  meta,
  children,
}: {
  meta?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="mark" aria-hidden="true">
          V
        </div>
        <div className="word as-typed">vectoree-starter</div>
        <div className="top-meta">
          {meta}
          <LocaleSwitch />
          <SocialLinks />
        </div>
      </header>
      {children}
      <Marquee />
    </div>
  );
}

export function LocaleSwitch() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="locale-switch" role="group" aria-label={t('languageToggle')}>
      <LocaleButton locale="en" current={locale} onPick={setLocale}>
        EN
      </LocaleButton>
      <LocaleButton locale="zh-CN" current={locale} onPick={setLocale}>
        中文
      </LocaleButton>
    </div>
  );
}

function LocaleButton({
  locale,
  current,
  onPick,
  children,
}: {
  locale: Locale;
  current: Locale;
  onPick: (locale: Locale) => void;
  children: string;
}) {
  const active = locale === current;
  return (
    <button type="button" className={active ? 'active' : undefined} aria-pressed={active} onClick={() => onPick(locale)}>
      {children}
    </button>
  );
}

const SOCIAL = [
  { href: 'https://discord.gg/SgbKCtqEgT', label: 'socialDiscord' as const, icon: 'discord' as const },
  { href: 'https://x.com/vectoreeai', label: 'socialX' as const, icon: 'x' as const },
  { href: 'https://github.com/VectoreeAI/', label: 'socialGitHub' as const, icon: 'github' as const },
];

export function SocialLinks() {
  const { t } = useI18n();
  return (
    <nav className="social-links" aria-label={t('socialLinks')}>
      {SOCIAL.map((item) => (
        <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer" aria-label={t(item.label)} title={t(item.label)}>
          {item.icon === 'discord' ? <DiscordIcon /> : item.icon === 'x' ? <XIcon /> : <GitHubIcon />}
        </a>
      ))}
    </nav>
  );
}

function DiscordIcon() {
  return (
    <svg viewBox="0 -28.5 256 256" aria-hidden="true">
      <path
        fill="currentColor"
        d="M216.856 16.597C200.285 8.843 182.566 3.208 164.042 0c-2.275 4.113-4.933 9.645-6.766 14.046-19.692-2.961-39.203-2.961-58.533 0-1.832-4.401-4.55-9.933-6.846-14.046C73.353 3.208 55.613 8.864 39.042 16.638 5.618 67.147-3.443 116.401 1.087 164.956c22.169 16.555 43.653 26.612 64.775 33.193 5.215-7.177 9.866-14.807 13.873-22.848-7.631-2.9-14.94-6.478-21.846-10.632 1.832-1.357 3.624-2.777 5.356-4.237 42.123 19.702 87.89 19.702 129.51 0 1.752 1.46 3.544 2.879 5.356 4.237-6.927 4.175-14.256 7.753-21.887 10.653 4.007 8.02 8.638 15.671 13.873 22.848 21.142-6.581 42.646-16.637 64.815-33.213 5.316-56.288-9.08-105.09-38.055-148.359zM85.474 135.095c-12.645 0-22.015-11.805-22.015-26.18 0-14.375 10.149-26.2 22.015-26.2 11.867 0 22.236 11.804 22.015 26.2-.02 14.375-10.148 26.18-22.015 26.18zm85.051 0c-12.645 0-23.015-11.805-23.015-26.18 0-14.375 10.148-26.2 23.015-26.2 12.866 0 23.236 11.804 23.015 26.2 0 14.375-10.148 26.18-23.015 26.18z"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        transform="translate(2.22, 2) scale(0.0163)"
        d="M714.163 519.284L1160.89 0H1055.03L667.137 450.887L357.328 0H0L468.492 681.821L0 1226.37H105.866L515.491 750.218L842.672 1226.37H1200L714.137 519.284H714.163ZM569.165 687.828L521.697 619.934L144.011 79.6944H306.615L611.412 515.685L658.88 583.579L1055.08 1150.3H892.476L569.165 687.854V687.828Z"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 0C18.6276 0 24 5.50792 24 12.3035C24 17.7383 20.5656 22.3487 15.8004 23.9771C15.192 24.0983 14.976 23.7141 14.976 23.3865C14.976 22.9809 14.9904 21.6562 14.9904 20.0098C14.9904 18.8626 14.6064 18.1138 14.1756 17.7322C16.848 17.4274 19.656 16.3869 19.656 11.6613C19.656 10.3173 19.1904 9.22058 18.42 8.35898C18.5448 8.04818 18.9564 6.79674 18.3024 5.10234C18.3024 5.10234 17.2968 4.77267 15.006 6.36387C14.0472 6.09147 13.02 5.95441 12 5.94961C10.98 5.95441 9.954 6.09147 8.9964 6.36387C6.7032 4.77267 5.6952 5.10234 5.6952 5.10234C5.0436 6.79674 5.4552 8.04818 5.5788 8.35898C4.812 9.22058 4.3428 10.3173 4.3428 11.6613C4.3428 16.3749 7.1448 17.4314 9.81 17.7422C9.4668 18.0494 9.156 18.5913 9.048 19.3869C8.364 19.7013 6.6264 20.2454 5.556 18.365C5.556 18.365 4.9212 17.1829 3.7164 17.0965C3.7164 17.0965 2.5464 17.0809 3.6348 17.8441C3.6348 17.8441 4.4208 18.2221 4.9668 19.6441C4.9668 19.6441 5.6712 21.8401 9.0096 21.0961C9.0156 22.1245 9.0264 23.0937 9.0264 23.3865C9.0264 23.7117 8.8056 24.0923 8.2068 23.9783C3.438 22.3523 0 17.7395 0 12.3035C0 5.50792 5.3736 0 12 0Z"
      />
    </svg>
  );
}

export function Gear() {
  return (
    <svg className="gear" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.8a.5.5 0 0 0-.49.42l-.36 2.54c-.59.22-1.14.53-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.14.23.41.32.64.22l2.39-.96c.49.41 1.04.72 1.63.94l.36 2.54c.05.24.26.42.49.42h3.8c.24 0 .45-.18.49-.42l.36-2.54c.59-.22 1.14-.53 1.63-.94l2.39.96c.23.1.5.01.64-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  );
}

export function Marquee() {
  const { t } = useI18n();
  const text = t('marquee');
  return (
    <footer className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {text.repeat(8)}
      </div>
    </footer>
  );
}

export function Stage({
  title,
  gloss,
  sticker,
  children,
}: {
  title: string;
  gloss: string;
  sticker: string;
  children: ReactNode;
}) {
  return (
    <main className="stage">
      <div className="stage-head">
        <div>
          <p className="eyebrow">{gloss}</p>
          <h1 className="display">{title}</h1>
        </div>
        <div className="sticker">{sticker}</div>
      </div>
      {children}
    </main>
  );
}
