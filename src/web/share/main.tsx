import '../styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { detectLang } from '../lib/i18n.ts';
import { I18nProvider } from '../lib/i18n-context.tsx';
import { App } from './App.tsx';

const lang = detectLang();
document.documentElement.lang = lang;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <I18nProvider lang={lang}>
      <App />
    </I18nProvider>
  </StrictMode>,
);
