/**
 * Runs `worker` over `items` with at most `concurrency` in flight.
 *
 * Refreshing a post is two sequential round-trips to WordPress (fetch the
 * content, then save it back) and almost all of that ~3s is waiting, not
 * work - a GET measures ~0.23s, so the rest is the save and its plugin
 * hooks. Sequentially that idles the whole run: 500 posts takes ~25
 * minutes while the server is barely touched.
 *
 * Concurrency is kept deliberately low anyway. Each lane is a WordPress
 * save, and a save here is not cheap - it fires plugin hooks (Advanced Ads
 * re-inserting its blocks, cache purging, SEO re-indexing). Three in flight
 * takes the rate from ~0.33 to ~1 request-pair/sec, which is unremarkable
 * for a site this size, and cuts a 500-post run from ~25 minutes to roughly
 * 8. Going much higher buys less and less while making a slow WordPress
 * response more likely to pile up.
 *
 * Order is not preserved; callers here don't depend on it. Worker errors
 * must be handled by the worker itself - a rejection would otherwise stop
 * that lane.
 */
export async function concurrentMap<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const lanes = Math.max(1, Math.min(concurrency, items.length));
  let next = 0;

  await Promise.all(
    Array.from({ length: lanes }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        await worker(items[index]);
      }
    }),
  );
}
