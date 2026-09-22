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
