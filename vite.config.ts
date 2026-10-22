import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type UserConfig } from 'vite';

const apps = {
  admin: { proxy: 'http://127.0.0.1:8080' },
  share: { proxy: 'http://127.0.0.1:8787' },
} as const;

export default defineConfig(({ mode }): UserConfig => {
  if (mode === 'sw') {
    return {
      build: {
        outDir: resolve('dist/share'),
        emptyOutDir: false,
        target: 'es2022',
        lib: { entry: resolve('src/web/sw.ts'), formats: ['iife'], name: 'piShareWorker', fileName: () => 'sw.js' },
      },
    };
  }

  const app = mode === 'share' ? 'share' : 'admin';
  return {
    root: resolve(`src/web/${app}`),
    publicDir: resolve('src/web/public'),
    plugins: [react(), tailwindcss()],
    build: { outDir: resolve(`dist/${app}`), emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
    server: { proxy: { '/api': apps[app].proxy } },
  };
});
