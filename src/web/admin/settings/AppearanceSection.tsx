import clsx from 'clsx';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n-context.tsx';
import { getTheme, setTheme, THEMES } from '../../lib/theme.ts';
import { Card } from '../../ui/Card.tsx';
import { SettingRow } from './Row.tsx';

export function AppearanceSection() {
  const { t } = useI18n();
  const [theme, setCurrent] = useState(getTheme);

  return (
    <Card>
      <SettingRow label={t('settings.theme')} hint={t('settings.themeHint')} stacked>
        <fieldset className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1">
          <legend className="sr-only">{t('settings.theme')}</legend>
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={theme === option}
              onClick={() => {
                setTheme(option);
                setCurrent(option);
              }}
              className={clsx(
                'press h-10 rounded-lg text-sm font-medium transition-colors',
                theme === option ? 'bg-surface text-fg shadow-card ring-1 ring-fg/15' : 'text-muted hover:text-fg',
              )}
            >
              {t(`theme.${option}`)}
            </button>
          ))}
        </fieldset>
      </SettingRow>
    </Card>
  );
}
