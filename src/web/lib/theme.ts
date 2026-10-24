export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

const STORAGE_KEY = 'pi-share:theme';
const BAR_COLORS = { light: '#f5f6f8', dark: '#0a0b0f' } as const;

export function getTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return THEMES.find((theme) => theme === stored) ?? 'system';
  } catch {
    return 'system';
  }
}

/** `system` leaves the choice to the `prefers-color-scheme` media query, the others pin it on `<html>`. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.dataset.theme = theme;

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    const scheme = meta.media.includes('dark') ? 'dark' : 'light';
    meta.content = BAR_COLORS[theme === 'system' ? scheme : theme];
  }
}

export function setTheme(theme: Theme) {
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // storage blocked: the choice still holds until the page is closed
  }
  applyTheme(theme);
}
