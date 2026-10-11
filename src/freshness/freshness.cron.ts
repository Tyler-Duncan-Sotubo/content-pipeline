import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FreshnessService } from "./freshness.service";

/**
 * Tracks which post IDs the morning refresh window touched today, so the
 * afternoon window (see runRefreshAfternoon) can re-touch exactly those same
 * posts rather than finding nothing to do (a post refreshed this morning
 * won't be "due" again under the normal 2.5-day interval for days). Keyed
 * by date so a stale list from a previous day (e.g. after a restart) is
 * never mistakenly reused - see loadTodaysTouchedIds().
 */
interface TodaysTouchedState {
  date: string; // YYYY-MM-DD, Africa/Lagos
  postIds: number[];
  /**
   * Fixed per-PM-run batch size, set once the first time the afternoon
   * window reads this file each day (from the full postIds.length at that
   * moment - i.e. the morning's final total, since the morning window has
   * always finished all 8 of its runs before 13:00). Recomputing
   * ceil(remaining/8) fresh on every PM run instead would make each batch
   * smaller than the last as the list shrinks, leaving a chunk of posts
   * never re-touched by the 8th run (confirmed by simulation: 1,826 posts
   * left 625 untouched) - a fixed divisor avoids that.
   */
  batchSize?: number;
}

function lagosDateKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }); // en-CA gives YYYY-MM-DD
}

/**
 * Two jobs:
 * - refresh pass: twice daily, 12 hours apart - reads the stored post-ID
 *   index (freshness-state.json) and refreshes overdue posts. The
 *   afternoon window specifically re-touches whatever the morning window
 *   touched (see below), giving Google two post_modified signals per day
 *   per post instead of one.
 * - index rebuild: daily - re-scans categories to pick up newly published
 *   posts into the index. Bloggers publish manually every day (not just the
 *   pipeline's own automated posts), so a new post needs same-day discovery,
 *   not up to a week's delay - buildIndex() itself is lightweight (just
 *   checks post IDs per category, no content edits), so daily is cheap.
 */
@Injectable()
export class FreshnessCronService {
  private readonly logger = new Logger(FreshnessCronService.name);
  private isRunning = false;
  private readonly touchedStateFile = join(process.cwd(), "freshness-touched-today.json");

  constructor(private readonly freshness: FreshnessService) {}

  private loadTodaysTouchedState(): TodaysTouchedState {
    if (!existsSync(this.touchedStateFile)) return { date: lagosDateKey(), postIds: [] };
    const state = JSON.parse(readFileSync(this.touchedStateFile, "utf8")) as TodaysTouchedState;
    if (state.date !== lagosDateKey()) return { date: lagosDateKey(), postIds: [] }; // stale - belongs to an earlier day
    return state;
  }

  private saveTodaysTouchedState(postIds: number[], batchSize?: number): void {
    const state: TodaysTouchedState = { date: lagosDateKey(), postIds, batchSize };
    writeFileSync(this.touchedStateFile, JSON.stringify(state, null, 2));
  }

  /**
   * Overnight window, 01:00-04:30 Lagos, every 30 minutes (8 runs), 250
   * posts per run.
   *
   * Both rotations used to run 500/run - large write bursts against
   * WordPress that were noticeably slowing the live site during the day.
   * Cutting to 250/run halves the burst size per run; running every 30
   * minutes keeps total daily throughput (8 x 250 = 2,000/day just from
   * this window) well above the ~1,825-post pool, so the whole pool cycles
   * comfortably inside its 2.5-day refresh interval with headroom to spare.
   *
   * This window owns 1:00-4:30am specifically so it never overlaps
   * old-posts' 4:30-6:00am slot (see OldPostsFreshnessCronService).
   *
   * Accumulates every post ID actually refreshed across all 8 runs into
   * freshness-touched-today.json, so the afternoon window (12h later) can
   * re-touch exactly those same posts - see runRefreshAfternoon().
   *
   * Self-healing: each run only touches posts that are actually overdue, so
   * a missed run doesn't skip anything - the next one finds them still due.
   */
  @Cron("0,30 1-4 * * *", { name: "freshness-refresh-am", timeZone: "Africa/Lagos" })
  async runRefreshMorning(): Promise<void> {
    // 1:00, 1:30, 2:00, 2:30, 3:00, 3:30, 4:00, 4:30 - 8 runs, stopping
    // exactly at 4:30 so this never overlaps old-posts' 4:30-6:00am window.
    if (process.env.DISABLE_CRONS === "true") return;
    if (this.isRunning) {
      this.logger.warn("Cron: freshness pass still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    this.logger.log("Cron: starting freshness refresh pass (AM)");
    try {
      const result = await this.freshness.runPass(250);
      const touchedSoFar = this.loadTodaysTouchedState().postIds;
      // batchSize deliberately omitted here (left undefined) - it's
      // computed once by the first PM run that reads this file today, from
      // the morning's final total. Setting it here too would be fine in
      // practice (the morning always finishes before 13:00) but leaving it
      // to the PM side keeps the "whoever first needs a fixed divisor,
      // computes it" responsibility in one place.
      this.saveTodaysTouchedState([...new Set([...touchedSoFar, ...result.refreshedIds])]);
      this.logger.log(`Cron: freshness pass (AM) done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness pass (AM) failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Afternoon window, 12 hours after the morning one - 13:00-16:30 Lagos,
   * every 30 minutes (8 runs). Added specifically so Google sees a
   * post_modified change twice a day instead of once: a single overnight
   * burst means every refresh signal lands in the same few hours and has
   * to wait a full day for the next one; a second touch 12h later gives
   * crawlers a second same-day chance to notice a change and re-index
   * sooner.
   *
   * Deliberately does NOT call runPass() again - a post refreshed this
   * morning won't be "due" again under the normal 2.5-day interval for
   * days, so a second isDue()-gated pass this afternoon would find almost
   * nothing to do. Instead it re-touches (via rerunPostIds, which bypasses
   * the interval check by design) exactly the post IDs the morning window
   * recorded as touched today, splitting that list evenly across this
   * window's 8 runs so the afternoon write load mirrors the morning's
   * shape instead of landing all at once.
   *
   * Doesn't need the 4:30-6:00am overlap guard the morning window has -
   * old-posts only runs overnight.
   */
  @Cron("0,30 13-16 * * *", { name: "freshness-refresh-pm", timeZone: "Africa/Lagos" })
  async runRefreshAfternoon(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    if (this.isRunning) {
      this.logger.warn("Cron: freshness pass still running from a previous trigger - skipping");
      return;
    }
    this.isRunning = true;
    this.logger.log("Cron: starting freshness re-touch pass (PM)");
    try {
      const state = this.loadTodaysTouchedState();
      const remaining = state.postIds;
      if (remaining.length === 0) {
        this.logger.log("Cron: freshness re-touch pass (PM) - nothing recorded from this morning, skipping");
        return;
      }
      // Fixed batch size, set ONCE per day by whichever PM run is first to
      // see this file today (state.batchSize is undefined until then) -
      // computed from the full remaining.length at that moment, i.e. the
      // morning's final total. Every subsequent PM run today reuses that
      // same fixed number rather than recomputing ceil(remaining/8) against
      // the shrinking list - recomputing fresh each time would make every
      // batch smaller than the last and leave a chunk of posts never
      // re-touched by the 8th run (confirmed by simulation: 1,826 posts ->
      // 625 left over under the recompute-each-time approach).
      const batchSize = state.batchSize ?? Math.max(1, Math.ceil(remaining.length / 8));
      const batch = remaining.slice(0, batchSize);
      const result = await this.freshness.rerunPostIds(batch);
      this.saveTodaysTouchedState(remaining.slice(batchSize), batchSize);
      this.logger.log(`Cron: freshness re-touch pass (PM) done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness re-touch pass (PM) failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }

  @Cron("0 5 * * *", { name: "freshness-index-build", timeZone: "Africa/Lagos" })
  async runIndexBuild(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    this.logger.log("Cron: starting freshness index build");
    try {
      const result = await this.freshness.buildIndex();
      this.logger.log(`Cron: freshness index build done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: freshness index build failed: ${(err as Error).message}`);
    }
  }
}
