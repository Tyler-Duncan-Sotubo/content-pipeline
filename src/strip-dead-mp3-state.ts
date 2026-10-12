import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resume state for the dead-mp3 batch sweep (cli-strip-dead-mp3-batch.ts) -
 * same pattern as freshness-state.json: a plain committed-or-local JSON
 * file so triggering the sweep again later picks up where it left off
 * instead of re-walking from the lowest post ID every time.
 */
export interface DeadMp3SweepState {
  /** Highest post ID the sweep has fully checked so far - for visibility/logging only, not used to decide what to skip. */
  lastCheckedId: number;
  /**
   * Last categories-listing PAGE (100/page, orderby=id asc) fully
   * processed - the actual resume cursor. Resuming by page number instead
   * of re-walking from page 1 and skipping by ID comparison avoids
   * re-fetching hundreds of already-done pages on every run once deep
   * into a ~40k-post sweep (orderby=id&order=asc is stable across runs:
   * the post set and these categories' membership for old posts don't
   * change, so "page 37 last time" is still "page 37" next time). 0 = never run.
   */
  lastPageProcessed: number;
  /** Running totals across all runs, for visibility. */
  totalChecked: number;
  totalFixed: number;
  /** ISO timestamp of the most recent run. */
  lastRunAt?: string;
}

const STATE_FILE = join(process.cwd(), "dead-mp3-sweep-state.json");

export function loadDeadMp3SweepState(): DeadMp3SweepState {
  if (!existsSync(STATE_FILE)) {
    return { lastCheckedId: 0, lastPageProcessed: 0, totalChecked: 0, totalFixed: 0 };
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as DeadMp3SweepState;
}

export function saveDeadMp3SweepState(state: DeadMp3SweepState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
