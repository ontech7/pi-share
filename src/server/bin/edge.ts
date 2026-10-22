import path from 'node:path';
import { loadConfig } from '../config.ts';
import { buildEdge } from '../edge.ts';
import { closeOnSignal, listen, readSecret } from '../listen.ts';

const config = loadConfig();
const edge = await buildEdge({
  config,
  brokerSecret: readSecret(config.brokerSecretFile),
  staticRoot: path.resolve(import.meta.dirname, '../../../dist/share'),
});

await listen(edge, config.publicListen, 0o666);
closeOnSignal(edge);
console.log(`pi-share edge on ${config.publicListen}`);
