/**
 * GitHub star count for the header, memoized per SSR process.
 *
 * Lives in a plain module because an Astro component's frontmatter runs on every
 * render, so state declared there never survives between requests. Only successful
 * lookups are cached; a failure returns null and the next render tries again.
 * Concurrent renders share one in-flight request.
 */
const REPO = 'k8adev/crossagent';
const TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 2000;

let cached: { stars: number; at: number } | null = null;
let inflight: Promise<number | null> | null = null;

async function fetchStars(): Promise<number | null> {
  /* Optional server-side token: lets the count resolve while the repo is still private. */
  const token = import.meta.env.GITHUB_TOKEN;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const repo = await response.json();
    return typeof repo?.stargazers_count === 'number' ? repo.stargazers_count : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getStars(now = Date.now()): Promise<number | null> {
  if (cached && now - cached.at < TTL_MS) return cached.stars;
  if (!inflight) {
    inflight = fetchStars()
      .then((stars) => {
        if (stars !== null) cached = { stars, at: Date.now() };
        return stars;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}
