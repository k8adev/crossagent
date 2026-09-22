import type { APIRoute } from 'astro';
import { DEFAULT_LOCALE, LOCALES, localeOf } from '../i18n';

export const GET: APIRoute = ({ site }) => {
  const base = site?.toString().replace(/\/$/, '') ?? 'https://crossagent.dev';

  const alternates = LOCALES
    .map(
      (l) =>
        `<xhtml:link rel="alternate" hreflang="${l.htmlLang}" href="${base}${l.path}"/>`,
    )
    .join('');
  const xDefault = `<xhtml:link rel="alternate" hreflang="x-default" href="${base}${localeOf(DEFAULT_LOCALE).path}"/>`;

  const urls = LOCALES
    .map(
      (l) => `  <url>
    <loc>${base}${l.path}</loc>
    ${alternates}
    ${xDefault}
  </url>`,
    )
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
