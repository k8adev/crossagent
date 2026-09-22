import type { APIRoute } from 'astro';

/* Two pages today (en, pt-BR). Each entry cross-links the other locale via xhtml:link. */
const pages = [
  { path: '/', lang: 'en' },
  { path: '/pt-br/', lang: 'pt-BR' },
];

export const GET: APIRoute = ({ site }) => {
  const base = site?.toString().replace(/\/$/, '') ?? 'https://crossagent.dev';

  const alternates = pages
    .map(
      (p) =>
        `<xhtml:link rel="alternate" hreflang="${p.lang}" href="${base}${p.path}"/>`,
    )
    .join('');
  const xDefault = `<xhtml:link rel="alternate" hreflang="x-default" href="${base}/"/>`;

  const urls = pages
    .map(
      (p) => `  <url>
    <loc>${base}${p.path}</loc>
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
