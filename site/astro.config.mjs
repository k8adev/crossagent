// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';

export default defineConfig({
  site: 'https://crossagent.dev',
  output: 'server',
  adapter: vercel(),
  i18n: {
    // Keep in sync with LOCALES / DEFAULT_LOCALE in src/i18n/index.ts (config files can't import that TS module).
    defaultLocale: 'en',
    locales: ['en', 'pt-br'],
    routing: {
      prefixDefaultLocale: false,
    },
  },
});
