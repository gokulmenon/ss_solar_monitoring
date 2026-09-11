export const CACHE_SECONDS = {
  weather: 15 * 60,
  energy: 15 * 60,
  uptime: 15 * 60,
  history: 15 * 60,
  csvHistory: 60 * 60,
} as const;

/**
 * Cache a shared, non-sensitive API response at Vercel's CDN. Browser caching
 * stays short so reopening the dashboard still feels current, while the CDN
 * prevents every device refresh from invoking a function.
 */
export function sharedCacheHeaders(maxAgeSeconds: number, staleSeconds = maxAgeSeconds * 4) {
  return {
    "Cache-Control": `public, max-age=60, s-maxage=${maxAgeSeconds}, stale-while-revalidate=${staleSeconds}`,
  };
}

export const noStoreHeaders = {
  "Cache-Control": "no-store, max-age=0",
};
