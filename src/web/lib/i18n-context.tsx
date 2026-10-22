import { createContext, type ReactNode, use, useMemo } from 'react';
import { type Lang, type Translate, translator } from './i18n.ts';

type I18n = { lang: Lang; t: Translate };

const I18nContext = createContext<I18n | null>(null);

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const value = useMemo(() => ({ lang, t: translator(lang) }), [lang]);
  return <I18nContext value={value}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const value = use(I18nContext);
  if (!value) throw new Error('useI18n outside I18nProvider');
  return value;
}
