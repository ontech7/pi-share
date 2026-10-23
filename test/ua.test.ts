import { describe, expect, it } from 'vitest';
import { previewApp } from '../src/web/lib/ua.ts';

describe('chat previews', () => {
  it('name the app behind the preview, iMessage and Teams included', () => {
    expect(previewApp('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)')).toBe('Discord');
    expect(previewApp('WhatsApp/2.23.20.0 A')).toBe('WhatsApp');
    expect(previewApp('TelegramBot (like TwitterBot)')).toBe('Telegram');
    expect(previewApp('Mozilla/5.0 (Macintosh) facebookexternalhit/1.1 Facebot Twitterbot/1.0')).toBe('iMessage');
    expect(previewApp('Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5')).toBe('Teams');
    expect(previewApp('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)')).toBe('Slack');
    expect(previewApp('curl/8.0')).toBeNull();
    expect(previewApp(null)).toBeNull();
  });
});
