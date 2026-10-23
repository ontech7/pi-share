import nodemailer from 'nodemailer';
import {
  type ChannelStatus,
  type NotificationChannel,
  type NotificationKind,
  type NotificationSettings,
  type NotificationsBody,
  notificationChannels,
  notificationsBody,
  type Provider,
} from '../shared/api.ts';
import { countryFlag } from '../web/lib/format.ts';
import { type Lang, translator } from '../web/lib/i18n.ts';
import { parseAgent, previewApp } from '../web/lib/ua.ts';
import type { Vault } from './crypto.ts';
import { RemoteFailure, remoteError } from './remote.ts';
import type { Settings } from './settings.ts';
import { type NewEvent, ShareError } from './shares.ts';

/** The same visitor doing the same thing on the same link is told once in this window. */
const QUIET = 15 * 60 * 1000;
/**
 * How many notifications fit in a window: per link, so one busy (or abused) link cannot use up the others'
 * share, and overall. Warnings have budgets of their own, per link and overall, so a flood of opens cannot
 * hide wrong passwords, nor one attacked link the warnings of the others; a lock happens once per lock and
 * always goes out.
 */
const WINDOW = 10 * 60 * 1000;
const BUDGET = { perLink: 5, overall: 30, warningsPerLink: 10, warnings: 30 };
const TIMEOUT = 15_000;

type Email = NotificationSettings['email'];

type Stored = {
  kinds: NotificationSettings['kinds'];
  lang: Lang;
  ntfy: { enabled: boolean; server: string; topic: string; sealedToken: string | null };
  telegram: { enabled: boolean; chatId: string; sealedToken: string | null };
  email: Omit<Email, 'hasPassword'> & { sealedPassword: string | null };
};

export type Message = { title: string; message: string; tags: string[]; priority: number };

export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  auth?: { user: string; pass: string };
};
export type Mail = { from: string; to: string; subject: string; text: string };
export type Mailer = (smtp: SmtpOptions, mail: Mail) => Promise<void>;

const smtpMailer: Mailer = async (smtp, mail) => {
  const transport = nodemailer.createTransport({
    ...smtp,
    connectionTimeout: TIMEOUT,
    greetingTimeout: TIMEOUT,
    socketTimeout: 2 * TIMEOUT,
  });
  try {
    await transport.sendMail(mail);
  } finally {
    transport.close();
  }
};

export type NotifierDeps = {
  settings: Settings;
  vault: Vault;
  providerOf: (ip: string | null) => Provider | null;
  lang: Lang;
  fetch?: typeof fetch;
  mailer?: Mailer;
  now?: () => number;
};

/** Which notification an event makes, if any. A preview counts only from a chat app it can name. */
function kindOf(event: NewEvent): NotificationKind | null {
  switch (event.type) {
    case 'open':
      return 'opens';
    case 'download_finished':
      return 'downloads';
    case 'password_failed':
    case 'locked':
      return 'warnings';
    case 'refused':
      return event.detail === 'network' || event.detail === 'exhausted' ? 'warnings' : null;
    case 'preview':
      return previewApp(event.userAgent ?? null) ? 'previews' : null;
    default:
      return null;
  }
}

/** Each channel, given what the admin saved, ready to send or not. */
function complete(stored: Stored, channel: NotificationChannel): boolean {
  if (channel === 'ntfy') return !!stored.ntfy.topic;
  if (channel === 'telegram') return !!stored.telegram.sealedToken && !!stored.telegram.chatId;
  return !!stored.email.host && !!stored.email.from && !!stored.email.to;
}

/**
 * Tells the owner what happens on the links, through the channels they set up: ntfy, a Telegram bot, email.
 * Never the link, its key or the visitor's address.
 */
export class Notifier {
  private readonly deps: NotifierDeps;
  private readonly lastSent = new Map<string, number>();
  private sentIn = new Map<string, number[]>();
  private readonly status: Record<NotificationChannel, ChannelStatus> = {
    ntfy: { lastSentAt: null, lastError: null },
    telegram: { lastSentAt: null, lastError: null },
    email: { lastSentAt: null, lastError: null },
  };

  constructor(deps: NotifierDeps) {
    this.deps = deps;
  }

  private get now() {
    return (this.deps.now ?? Date.now)();
  }

  private secret(sealed: string | null, channel: NotificationChannel): string {
    if (!sealed) return '';
    try {
      return this.deps.vault.open(sealed, `notifications/${channel}`).toString();
    } catch {
      throw new RemoteFailure('unreadable');
    }
  }

  private seal(value: string | null | undefined, channel: NotificationChannel, current: string | null) {
    if (value === undefined) return current;
    return value === null ? null : this.deps.vault.seal(Buffer.from(value), `notifications/${channel}`);
  }

  private stored(): Stored {
    const saved = this.deps.settings.notifications<Partial<Stored>>() ?? {};
    return {
      kinds: { opens: true, downloads: true, warnings: true, previews: true, ...saved.kinds },
      lang: saved.lang ?? this.deps.lang,
      ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', sealedToken: null, ...saved.ntfy },
      telegram: { enabled: false, chatId: '', sealedToken: null, ...saved.telegram },
      email: {
        enabled: false,
        host: '',
        port: 587,
        security: 'starttls',
        user: '',
        sealedPassword: null,
        from: '',
        to: '',
        ...saved.email,
      },
    };
  }

  view(): NotificationSettings {
    const { ntfy, telegram, email, ...rest } = this.stored();
    const { sealedToken: ntfyToken, ...ntfyView } = ntfy;
    const { sealedToken: telegramToken, ...telegramView } = telegram;
    const { sealedPassword, ...emailView } = email;
    return {
      ...rest,
      ntfy: { ...ntfyView, hasToken: ntfyToken !== null },
      telegram: { ...telegramView, hasToken: telegramToken !== null },
      email: { ...emailView, hasPassword: sealedPassword !== null },
      status: structuredClone(this.status),
    };
  }

  update(input: NotificationsBody): NotificationSettings {
    const patch = notificationsBody.parse(input);
    const current = this.stored();
    const { token: ntfyToken, ...ntfy } = patch.ntfy ?? {};
    const { token: telegramToken, ...telegram } = patch.telegram ?? {};
    const { password, ...email } = patch.email ?? {};
    const next: Stored = {
      kinds: { ...current.kinds, ...patch.kinds },
      lang: patch.lang ?? current.lang,
      ntfy: {
        ...current.ntfy,
        ...ntfy,
        server: (ntfy.server ?? current.ntfy.server).replace(/\/+$/, ''),
        sealedToken: this.seal(ntfyToken, 'ntfy', current.ntfy.sealedToken),
      },
      telegram: {
        ...current.telegram,
        ...telegram,
        sealedToken: this.seal(telegramToken, 'telegram', current.telegram.sealedToken),
      },
      email: {
        ...current.email,
        ...email,
        sealedPassword: this.seal(password, 'email', current.email.sealedPassword),
      },
    };
    for (const channel of notificationChannels) {
      if (next[channel].enabled && !complete(next, channel)) throw new ShareError(400, 'incomplete', { channel });
    }
    this.deps.settings.setNotifications(next);
    return this.view();
  }

  /** Called for every recorded event; whatever happens here, recording the event goes on. */
  onEvent(linkId: string, event: NewEvent, labelOf: () => string | null) {
    try {
      // Most events never make a notification: they cost nothing past this line.
      const kind = kindOf(event);
      if (!kind) return;
      const stored = this.stored();
      const channels = notificationChannels.filter((channel) => stored[channel].enabled && complete(stored, channel));
      if (!stored.kinds[kind] || channels.length === 0) return;
      const label = labelOf();
      if (label === null) return;
      const who = event.type === 'preview' ? '' : (event.visitor ?? event.ip ?? '');
      const key = `${linkId} ${event.type} ${event.detail ?? ''} ${who}`;
      const now = this.now;
      if (event.type !== 'locked') {
        if (now - (this.lastSent.get(key) ?? 0) < QUIET) return;
        const budgets: [string, number][] =
          kind === 'warnings'
            ? [
                [`warnings ${linkId}`, BUDGET.warningsPerLink],
                ['warnings', BUDGET.warnings],
              ]
            : [
                [`link ${linkId}`, BUDGET.perLink],
                ['overall', BUDGET.overall],
              ];
        for (const [budget] of budgets) this.sentIn.set(budget, this.spent(budget, now));
        if (budgets.some(([budget, max]) => (this.sentIn.get(budget)?.length ?? 0) >= max)) return;
        for (const [budget] of budgets) this.sentIn.get(budget)?.push(now);
      }
      this.lastSent.set(key, now);
      for (const [stale, at] of this.lastSent) if (now - at >= QUIET) this.lastSent.delete(stale);
      for (const budget of this.sentIn.keys()) if (this.spent(budget, now).length === 0) this.sentIn.delete(budget);
      const message = this.compose(stored.lang, label, kind, event);
      for (const channel of channels) void this.send(stored, channel, message).catch(() => undefined);
    } catch {
      // a notification is never worth failing a visit for
    }
  }

  private spent(budget: string, now: number): number[] {
    return (this.sentIn.get(budget) ?? []).filter((at) => now - at < WINDOW);
  }

  async test(channel: NotificationChannel): Promise<NotificationSettings> {
    const stored = this.stored();
    if (!complete(stored, channel)) throw new ShareError(400, 'incomplete', { channel });
    const message = { title: 'pi-share', message: translator(stored.lang)('notify.test'), tags: ['wave'], priority: 3 };
    try {
      await this.send(stored, channel, message);
    } catch {
      throw new ShareError(502, 'notify_failed', { channel, detail: this.status[channel].lastError });
    }
    return this.view();
  }

  private compose(lang: Lang, label: string, kind: NotificationKind, event: NewEvent): Message {
    const t = translator(lang);
    const provider = this.deps.providerOf(event.ip ?? null);
    const agent = event.type === 'preview' ? null : parseAgent(event.userAgent ?? null);
    const what =
      event.type === 'refused'
        ? t(event.detail === 'network' ? 'notify.refusedNetwork' : 'notify.refusedExhausted')
        : event.type === 'preview'
          ? t('notify.preview', { app: previewApp(event.userAgent ?? null) ?? '' })
          : t(`event.${event.type}`);
    // Cloudflare marks Tor exits with T1 and unknown places with XX: neither is a country.
    const flag = countryFlag(event.country ?? null);
    const country = event.country?.toUpperCase() === 'T1' ? 'Tor' : flag ? `${flag} ${event.country}` : '';
    const details = [
      country,
      provider && `${provider.name}${provider.hosting ? ` (${t('provider.hosting')})` : ''}`,
      agent && [agent.browser, agent.os].filter(Boolean).join(' · '),
    ].filter(Boolean);
    const tags = {
      opens: ['eyes'],
      downloads: ['white_check_mark'],
      warnings: ['warning'],
      previews: ['speech_balloon'],
    };
    return {
      title: (label || t('links.untitled')).replace(/\s+/g, ' '),
      message: [what, details.join(' · ')].filter(Boolean).join('\n'),
      tags: tags[kind],
      priority: event.type === 'locked' ? 5 : kind === 'warnings' ? 4 : 3,
    };
  }

  private async send(stored: Stored, channel: NotificationChannel, message: Message) {
    const secret = channel === 'email' ? stored.email.sealedPassword : stored[channel].sealedToken;
    let plain = '';
    try {
      plain = this.secret(secret, channel);
      if (channel === 'ntfy') await this.ntfy(stored.ntfy, plain, message);
      else if (channel === 'telegram') await this.telegram(stored.telegram.chatId, plain, message);
      else await this.email(stored.email, plain, message);
      this.status[channel] = { lastSentAt: this.now, lastError: null };
    } catch (error) {
      // Whatever the server says, the secret never ends up in what the admin is shown.
      this.status[channel] = { ...this.status[channel], lastError: remoteError(error, plain) };
      throw error;
    }
  }

  private async post(url: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await (this.deps.fetch ?? fetch)(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
      // A redirect would carry the message, and maybe the token, to a server nobody configured.
      redirect: 'error',
    });
    const text = (await response.text().catch(() => '')).slice(0, 2_000);
    return { ok: response.ok, status: response.status, text };
  }

  private async ntfy(settings: Stored['ntfy'], token: string, message: Message) {
    const response = await this.post(
      `${settings.server}/`,
      { topic: settings.topic, ...message },
      token ? { authorization: `Bearer ${token}` } : {},
    );
    if (!response.ok) throw new RemoteFailure('status', String(response.status));
  }

  private async telegram(chatId: string, token: string, message: Message) {
    const response = await this.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: `${message.title}\n${message.message}`,
      disable_web_page_preview: true,
    });
    if (!response.ok) {
      let description = '';
      try {
        description = String((JSON.parse(response.text) as { description?: unknown }).description ?? '');
      } catch {
        // not JSON: the status says enough
      }
      throw description
        ? new RemoteFailure('rejected', description)
        : new RemoteFailure('status', String(response.status));
    }
  }

  private async email(settings: Stored['email'], password: string, message: Message) {
    await (this.deps.mailer ?? smtpMailer)(
      {
        host: settings.host,
        port: settings.port,
        secure: settings.security === 'tls',
        requireTLS: settings.security === 'starttls',
        ignoreTLS: settings.security === 'none',
        auth: settings.user ? { user: settings.user, pass: password } : undefined,
      },
      { from: settings.from, to: settings.to, subject: `pi-share · ${message.title}`, text: message.message },
    );
  }
}
