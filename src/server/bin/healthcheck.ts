import { Agent, request } from 'undici';

const address = process.argv[2] ?? '';
const unix = address.startsWith('unix:');

try {
  const response = await request(unix ? 'http://localhost/healthz' : `http://${address}/healthz`, {
    dispatcher: unix ? new Agent({ connect: { socketPath: address.slice(5) } }) : undefined,
    headersTimeout: 3000,
    bodyTimeout: 3000,
  });
  await response.body.dump();
  process.exit(response.statusCode < 500 ? 0 : 1);
} catch {
  process.exit(1);
}
