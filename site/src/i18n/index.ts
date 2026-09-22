import { en } from './en';
import { ptBr } from './pt-br';

export type Lang = 'en' | 'pt-br';

const dictionaries = {
  en,
  'pt-br': ptBr,
} as const;

export function t(lang: Lang) {
  return dictionaries[lang];
}

/** Single source of truth for the locales this site serves. Keep in sync with astro.config.mjs's i18n.locales. */
export const LOCALES = [
  {
    code: 'en',
    htmlLang: 'en',
    path: '/',
    ogLocale: 'en_US',
    label: 'en',
  },
  {
    code: 'pt-br',
    htmlLang: 'pt-BR',
    path: '/pt-br/',
    ogLocale: 'pt_BR',
    label: 'pt',
  },
] as const satisfies ReadonlyArray<{
  code: Lang;
  htmlLang: 'en' | 'pt-BR';
  path: '/' | '/pt-br/';
  ogLocale: 'en_US' | 'pt_BR';
  label: 'en' | 'pt';
}>;

export const DEFAULT_LOCALE: Lang = 'en';

export function localeOf(lang: Lang) {
  return LOCALES.find((locale) => locale.code === lang)!;
}
