export type Agent = { browser: string; os: string; mobile: boolean };

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)|FxiOS\/(\d+)/, 'Firefox'],
  [/Chrome\/(\d+)|CriOS\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* .*Safari\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/Windows NT/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const BOTS = /bot|crawl|spider|preview|curl|wget|python|go-http/i;

export function parseAgent(userAgent: string | null): Agent | null {
  if (!userAgent) return null;
  if (BOTS.test(userAgent)) {
    const name = /([\w-]*bot[\w-]*)/i.exec(userAgent)?.[1] ?? userAgent.split(/[ /]/)[0] ?? 'Bot';
    return { browser: name, os: '', mobile: false };
  }
  let browser = 'Browser';
  for (const [pattern, name] of BROWSERS) {
    const match = pattern.exec(userAgent);
    if (match) {
      const version = match.slice(1).find(Boolean);
      browser = version ? `${name} ${version}` : name;
      break;
    }
  }
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? '';
  return { browser, os, mobile: /Mobi|Android|iPhone/.test(userAgent) };
}

/** Order matters: iMessage announces itself as Facebook and Twitter at once, Teams as Skype. */
const PREVIEWERS: [RegExp, string][] = [
  [/facebookexternalhit.*Twitterbot/i, 'iMessage'],
  [/Discordbot/i, 'Discord'],
  [/WhatsApp/i, 'WhatsApp'],
  [/TelegramBot/i, 'Telegram'],
  [/Slack/i, 'Slack'],
  [/SkypeUriPreview|Teams/i, 'Teams'],
  [/facebookexternalhit|Facebot/i, 'Facebook'],
  [/Twitterbot/i, 'X'],
  [/LinkedInBot/i, 'LinkedIn'],
  [/Signal/i, 'Signal'],
  [/Viber/i, 'Viber'],
  [/redditbot/i, 'Reddit'],
  [/Google-PageRenderer|Google-Chat/i, 'Google Chat'],
];

/** The chat app that fetched a link to show its preview, when the user agent says which. */
export function previewApp(userAgent: string | null): string | null {
  if (!userAgent) return null;
  return PREVIEWERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
}
