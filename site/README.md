# crossagent-site

Astro site for crossagent, server-rendered on Vercel.

## Develop

- `pnpm install`
- `pnpm dev` — local dev server
- `pnpm build` — production build through the Vercel adapter

## Environment

Copy `.env.example` and fill it in. `PUBLIC_POSTHOG_KEY` is the PostHog project
token (analytics is skipped when empty) and `PUBLIC_POSTHOG_HOST` is the PostHog
host, `https://us.i.posthog.com` for US Cloud.

## Deploy

On Vercel set the project **Root Directory** to `site`, and add both env vars.
