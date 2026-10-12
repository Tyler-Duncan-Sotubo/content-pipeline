import { Injectable, Logger } from "@nestjs/common";
import { WordpressService } from "../publish/wordpress.service";
import { LinksService } from "../links/links.service";
import { stripDeadMp3 } from "../strip-dead-mp3";
import { stripBakedAds } from "../strip-baked-ads";
import { loadDeadMp3SweepState, saveDeadMp3SweepState } from "../strip-dead-mp3-state";

/**
 * Resumable sweep that walks posts (oldest ID first) across the 9
 * freshness categories plus next-rated (10 total), stripping dead legacy
 * MP3 elements (see strip-dead-mp3.ts) and replacing them with a real
 * YouTube/Spotify link where one's found. Originally a manually-triggered
 * CLI tool (cli-strip-dead-mp3-batch.ts, still available for ad-hoc runs);
 * promoted to this service so a cron (DeadMp3SweepCronService) can drive
 * it automatically every 5 minutes instead of needing someone to remember
 * to trigger it by hand.
 *
 * Progress (dead-mp3-sweep-state.json) is shared between the CLI and the
 * cron - whichever ran most recently is where the other picks up from.
 */
const CATEGORY_SLUGS = [
  "songs",
  "south-africa",
  "congo",
  "kenya",
  "lyrics",
  "tanzania",
  "ghana-music",
  "zambia",
  "united-kingdom",
  "next-rated",
];

function cleanTitleForSearch(title: string): string {
  return title
    .replace(/<[^>]+>/g, "")
    .replace(/&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

@Injectable()
export class DeadMp3SweepService {
  private readonly logger = new Logger(DeadMp3SweepService.name);
  private readonly categoryIds: Map<string, number> = new Map();

  constructor(
    private readonly wordpress: WordpressService,
    private readonly links: LinksService,
  ) {}

  private async resolveCategoryIds(): Promise<number[]> {
    const ids: number[] = [];
    for (const slug of CATEGORY_SLUGS) {
      if (!this.categoryIds.has(slug)) {
        const id = await this.wordpress.resolveCategoryIdBySlug(slug);
        if (id) this.categoryIds.set(slug, id);
      }
      const id = this.categoryIds.get(slug);
      if (id) ids.push(id);
    }
    return [...new Set(ids)];
  }

  /**
   * Checks up to `limit` in-scope posts (not necessarily `limit` FIXED
   * posts - most checked posts won't match at all), fixing any that have
   * a dead audio/download element, and advances the resume cursor. With
   * dryRun, logs what would change and writes nothing (including leaving
   * the resume cursor untouched, same as the CLI's --dry-run).
   */
  async runSweep(
    limit = 50,
    addLink = true,
    dryRun = false,
  ): Promise<{ checked: number; fixed: number; failed: number }> {
    const categoryIds = await this.resolveCategoryIds();
    if (categoryIds.length === 0) {
      this.logger.warn("No categories resolved - nothing to sweep");
      return { checked: 0, fixed: 0, failed: 0 };
    }

    const state = loadDeadMp3SweepState();
    let checked = 0;
    let fixed = 0;
    let failed = 0;
    let highestIdSeen = state.lastCheckedId;
    let page = state.lastPageProcessed + 1;
    let lastPageFullyDone = state.lastPageProcessed;
    const perPage = 100;

    outer: for (;;) {
      const posts = await this.wordpress.listPostsByCategoriesOldestFirst(categoryIds, page, perPage);
      if (posts.length === 0) break; // reached the end of the scoped categories

      for (const post of posts) {
        // Stop mid-page if we hit the limit - this page is NOT fully done,
        // so lastPageFullyDone stays at its current (previous-page) value,
        // never this one, or the next run would skip this page's
        // remaining unprocessed posts.
        if (checked >= limit) break outer;

        checked++;
        highestIdSeen = Math.max(highestIdSeen, post.id);

        const title = post.title.rendered;

        // Cheap pre-check before doing any work - avoids an unnecessary
        // YouTube/Spotify lookup for every single checked post.
        const looksAffected =
          /<audio\b[^>]*>[\s\S]*?(?:hub\.tooxclusive\.com|tooxclusive\.com\/wp-content\/uploads)/i.test(
            post.content.rendered,
          );
        if (!looksAffected) continue;

        let replacementUrl: string | undefined;
        if (addLink) {
          const query = cleanTitleForSearch(title);
          try {
            const found = await this.links.findYouTubeThenSpotify(query);
            if (found) replacementUrl = found.url;
          } catch (err) {
            this.logger.warn(`Link lookup failed for post ${post.id}: ${(err as Error).message}`);
          }
        }

        const result = stripDeadMp3(post.content.rendered, replacementUrl);
        const changedAnything =
          result.removedAudio > 0 || result.removedDownloadButton > 0 || result.removedLastVerified > 0;
        if (!changedAnything) continue;

        if (dryRun) {
          fixed++;
          this.logger.log(`[dry-run] Would fix post ${post.id} ("${title}")`);
          continue;
        }

        try {
          await this.wordpress.patchPost(post.id, { content: stripBakedAds(result.content).content });
          fixed++;
          // Logged at warn (not info) so a real fix stands out/is easy to
          // filter on in Better Stack - confirmed live that info-level
          // lines reach Better Stack fine too (production's LOGTAIL_LEVEL
          // isn't actually "warn" despite that being the code's default),
          // so this is a visibility choice, not a requirement. Still rare
          // enough (a handful per hundred-plus checked) not to approach
          // the log-volume problem that caused the Sept 1 outage.
          this.logger.warn(
            `Fixed post ${post.id} ("${title}"): audio x${result.removedAudio}, ` +
              `download x${result.removedDownloadButton}, last-verified x${result.removedLastVerified}` +
              (replacementUrl ? `, replacement: ${replacementUrl}` : ""),
          );
        } catch (err) {
          failed++;
          this.logger.warn(`Failed to save post ${post.id}: ${(err as Error).message}`);
        }
      }

      // Reached only by finishing this page's for-loop WITHOUT hitting the
      // limit (the limit path takes `break outer` above instead).
      lastPageFullyDone = page;
      page++;
    }

    if (!dryRun) {
      saveDeadMp3SweepState({
        lastCheckedId: highestIdSeen,
        lastPageProcessed: lastPageFullyDone,
        totalChecked: state.totalChecked + checked,
        totalFixed: state.totalFixed + fixed,
        lastRunAt: new Date().toISOString(),
      });
    }

    return { checked, fixed, failed };
  }
}
