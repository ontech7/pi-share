// End-to-end smoke test in a real browser: admin setup, link creation, recipient download
// through the service worker, byte-for-byte check, activity in the admin. Needs `pnpm build` first.
// Screenshots land in e2e/.out/shots. CHROME_PATH overrides the browser binary.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'e2e/.out');
const shots = path.join(out, 'shots');
const downloads = path.join(out, 'downloads');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-e2e-'));
const storage = path.join(work, 'storage');
const sockets = fs.mkdtempSync('/tmp/ps-');
const chromePath =
  process.env.CHROME_PATH ??
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const scheme = process.env.COLOR_SCHEME ?? 'dark';
const ADMIN = 'http://127.0.0.1:18080';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(shots, { recursive: true });
fs.mkdirSync(downloads, { recursive: true });
fs.mkdirSync(path.join(storage, 'Work'), { recursive: true });
fs.mkdirSync(path.join(storage, 'Media'), { recursive: true });
fs.mkdirSync(path.join(storage, 'Private'), { recursive: true });
fs.writeFileSync(path.join(storage, 'Work/project.zip'), crypto.randomBytes(5 * 1024 * 1024));
fs.writeFileSync(path.join(storage, 'Work/notes.txt'), 'notes');
fs.writeFileSync(path.join(storage, 'Media/video.bin'), crypto.randomBytes(40 * 1024 * 1024 + 123));
fs.writeFileSync(path.join(storage, 'Private/secret.txt'), 'secret');

const env = {
  ...process.env,
  STORAGE_ROOT: storage,
  DATA_DIR: path.join(work, 'data'),
  PUBLIC_URL: 'http://localhost:18787',
  ADMIN_LISTEN: '127.0.0.1:18080',
  BROKER_LISTEN: `unix:${sockets}/broker.sock`,
  BROKER_URL: `unix:${sockets}/broker.sock`,
  PUBLIC_LISTEN: '127.0.0.1:18787',
  DENY_PATHS: 'Private',
  ADMIN_LANG: 'en',
  LOG_LEVEL: 'warn',
};

const processes = [];
function start(script) {
  const child = spawn(process.execPath, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  processes.push(child);
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

async function until(check, label, timeout = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error(`timeout: ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

const admin = start('src/server/bin/admin.ts');
await until(() => admin.output().includes('admin on'), 'admin start');
const setupCode = /setup code ([A-Z0-9-]+)/.exec(admin.output())?.[1];
start('src/server/bin/edge.ts');
await until(async () => (await fetch('http://127.0.0.1:18787/').catch(() => null))?.status === 404, 'edge start');

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--remote-debugging-port=9334',
    `--user-data-dir=${path.join(work, 'profile')}`,
    '--no-first-run',
    '--lang=en-US',
    '--window-size=1280,900',
    // CI runners (Ubuntu 24.04) forbid the user namespaces Chrome's sandbox needs; the page under test is our own.
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
  ],
  { stdio: 'ignore', env: { ...process.env, LANG: 'en_US.UTF-8', LANGUAGE: 'en' } },
);
processes.push(chrome);

let version;
await until(async () => {
  version = await fetch('http://127.0.0.1:9334/json/version')
    .then((r) => r.json())
    .catch(() => null);
  return !!version;
}, 'chrome start');

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));
let nextId = 1;
const pending = new Map();
const listeners = [];
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  } else for (const listener of listeners) listener(message);
});
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

const pages = [];

async function openPage(url, browserContextId) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, sessionId);
  await send('Emulation.setLocaleOverride', { locale: 'en-US' }, sessionId);
  await send(
    'Emulation.setUserAgentOverride',
    { userAgent: version['User-Agent'], acceptLanguage: 'en-US,en' },
    sessionId,
  );
  const page = {
    errors: [],
    async go(target) {
      await send('Page.navigate', { url: target }, sessionId);
      await sleep(800);
    },
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async text(fragment, timeout) {
      await until(
        () => page.eval(`document.body.innerText.includes(${JSON.stringify(fragment)})`),
        `text "${fragment}"`,
        timeout,
      );
    },
    async type(selector, value) {
      await page.eval(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await send('Input.insertText', { text: value }, sessionId);
    },
    async fill(selector, index, value) {
      await page.eval(`(() => {
        const input = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
    },
    async click(label) {
      const clicked = await page.eval(
        `(() => { const el = [...document.querySelectorAll('button, a')].find((e) => e.textContent.trim().includes(${JSON.stringify(label)})); if (!el) return false; el.click(); return true; })()`,
      );
      if (!clicked) throw new Error(`nothing to click with "${label}"`);
      await sleep(300);
    },
    async shot(name, { width = 1280, height = 900, mobile = false } = {}) {
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile },
        sessionId,
      );
      await sleep(300);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'));
      await send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
    },
  };
  listeners.push((message) => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown')
      page.errors.push(message.params.exceptionDetails.exception?.description);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      page.errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
  });
  pages.push(page);
  await page.go(url);
  return page;
}

try {
  console.log('admin');
  const panel = await openPage(`${ADMIN}/`);
  await panel.text('First run');
  await panel.shot('01-setup');
  await panel.fill('input', 0, setupCode);
  await panel.fill('input', 1, 'a long admin password');
  await panel.fill('input', 2, 'a long admin password');
  await panel.click('Create password');
  await panel.text('No links yet');
  assert(true, 'setup with the code from the logs');
  await panel.shot('02-empty');

  await panel.click('New link');
  await panel.text('Work');
  assert(!(await panel.eval(`document.body.innerText.includes('Private')`)), 'denied folder is hidden');
  await panel.click('Work');
  await panel.text('project.zip');
  await panel.click('project.zip');
  await panel.click('notes.txt');
  await panel.click('Disk');
  await panel.click('Media');
  await panel.text('video.bin');
  await panel.click('video.bin');
  await panel.shot('03-picker');
  await panel.click('Continue');
  await panel.fill('dialog input', 0, 'Smoke test');
  await panel.click('Generate');
  const password = await panel.eval(`document.querySelectorAll('dialog input')[1].value`);
  await panel.click('Create link');
  await panel.text('Link ready');
  const url = await panel.eval(
    `[...document.querySelectorAll('dialog p')].map((p) => p.textContent).find((t) => t.includes('/d/'))`,
  );
  assert(/\/d\/[\w-]+#[\w-]{43}$/.test(url), 'link carries the key in the fragment');
  await panel.shot('04-ready');
  await panel.click('Close');

  console.log('recipient');
  const { browserContextId } = await send('Target.createBrowserContext');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, browserContextId });
  const share = await openPage(url, browserContextId);
  await share.text('This link is protected');
  await share.fill('input[type=password]', 0, 'wrong password');
  await share.click('Unlock');
  await share.text('Wrong password', 20_000);
  assert(true, 'wrong password is refused');
  await share.fill('input[type=password]', 0, password);
  await share.click('Unlock');
  await share.text('Files shared with you', 20_000);
  await share.shot('05-recipient');
  await share.shot('05-recipient-mobile', { width: 390, height: 844, mobile: true });
  await until(() => share.eval(`!!navigator.serviceWorker.controller`), 'service worker control');
  assert(true, 'service worker controls the page');

  await share.eval(
    `[...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Download')[2].click()`,
  );
  await share.text('Downloaded and verified', 60_000);
  await until(() => fs.existsSync(path.join(downloads, 'video.bin')), 'video on disk');
  assert(
    sha(path.join(downloads, 'video.bin')) === sha(path.join(storage, 'Media/video.bin')),
    'downloaded file matches the original',
  );

  await share.click('Download all');
  await until(
    () => share.eval(`document.body.innerText.split('Downloaded and verified').length > 2`),
    'zip verified',
    60_000,
  );
  await until(() => fs.existsSync(path.join(downloads, 'Smoke test.zip')), 'zip on disk');
  await share.shot('06-verified');
  assert(share.errors.length === 0, `recipient page without errors ${share.errors.join(' | ')}`);

  console.log('activity');
  await panel.go(`${ADMIN}${await panel.eval('location.pathname')}`);
  await panel.text('Downloaded and verified');
  const counts = await panel.eval(`[...document.querySelectorAll('dl dd')].map((d) => d.textContent)`);
  assert(JSON.stringify(counts) === JSON.stringify(['1', '2', '2', '1', '1']), `counters ${counts.join(', ')}`);
  await panel.shot('07-activity');

  console.log('live folder');
  await panel.go(`${ADMIN}/`);
  await panel.click('New link');
  await panel.text('Work');
  await panel.eval(`document.querySelector('[aria-label="Folder Work"]').click()`);
  await panel.text('1 selected');
  await panel.shot('08-folder-picker');
  await panel.click('Continue');
  await panel.click('Follow the changes');
  await panel.click('Create link');
  await panel.text('Link ready');
  const folderUrl = await panel.eval(
    `[...document.querySelectorAll('dialog p')].map((p) => p.textContent).find((t) => t.includes('/d/'))`,
  );
  await panel.click('Close');
  fs.writeFileSync(path.join(storage, 'Work/later.txt'), 'added after the link');
  await sleep(3_500); // folder listings are cached for a few seconds

  const folderContext = await send('Target.createBrowserContext');
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: downloads,
    browserContextId: folderContext.browserContextId,
  });
  const folder = await openPage(folderUrl, folderContext.browserContextId);
  await folder.text('Files shared with you', 20_000);
  await folder.text('later.txt');
  assert(await folder.eval(`document.body.innerText.includes('project.zip')`), 'folder opens on its files');
  await folder.shot('08-folder');
  await folder.shot('08-folder-mobile', { width: 390, height: 844, mobile: true });
  await until(() => folder.eval(`!!navigator.serviceWorker.controller`), 'service worker control');
  await folder.click('Download all');
  await folder.text('Downloaded and verified', 60_000);
  await until(() => fs.existsSync(path.join(downloads, 'Work.zip')), 'folder zip on disk');
  assert(folder.errors.length === 0, `folder page without errors ${folder.errors.join(' | ')}`);

  console.log('settings');
  await panel.go(`${ADMIN}/settings`);
  await panel.text('Public page on');
  await panel.shot('09-settings-mobile', { width: 390, height: 844, mobile: true });
  await panel.click('New links');
  await panel.text('Where every new link starts from');
  await panel.click('Follow the changes');
  await panel.text('Saved');
  await panel.shot('10-settings');
  await panel.shot('10-settings-mobile', { width: 390, height: 844, mobile: true });
  const saved = await panel.eval(`fetch('/api/preferences').then((r) => r.json())`);
  assert(saved.onChange === 'follow', 'settings page saves the defaults for new links');

  assert(panel.errors.length === 0, `admin without errors ${panel.errors.join(' | ')}`);
  console.log('\nsmoke test passed');
} catch (error) {
  console.error('\nsmoke test FAILED:', error.message);
  for (const page of pages) await page.shot('failure').catch(() => undefined);
  process.exitCode = 1;
} finally {
  ws.close();
  await Promise.all(
    processes.map((child) => {
      if (child.exitCode !== null) return undefined;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      return exited;
    }),
  );
  // Chrome's helper processes can still be writing to the profile: leftovers in a temp dir are not a failure.
  for (const dir of [work, sockets]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      console.warn(`could not remove ${dir}: ${error.message}`);
    }
  }
}
