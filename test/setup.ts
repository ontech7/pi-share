import { afterAll } from 'vitest';
import { removeTempDirs } from './helpers.ts';

// Registered before any test file's own hooks, so it runs after them: stacks are closed before their dirs go.
afterAll(removeTempDirs);
