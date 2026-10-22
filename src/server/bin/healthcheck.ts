import { Agent, request } from 'undici';

const address = process.argv[2] ?? '';
// The edge answers 404 to anything that is not a link, on purpose: that is its healthy answer.
const expected = Number(process.argv[3] ?? 200);
const unix = address.startsWith('unix:');

try {
  const response = await request(unix ? 'http://localhost/healthz' : `http://${address}/healthz`, {
    dispatcher: unix ? new Agent({ connect: { socketPath: address.slice(5) } }) : undefined,
    headersTimeout: 3000,
    bodyTimeout: 3000,
  });
  await response.body.dump();
  process.exit(response.statusCode === expected ? 0 : 1);
} catch {
  process.exit(1);
}
