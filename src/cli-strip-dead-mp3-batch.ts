/**
 * Manual, one-shot trigger for the dead-mp3 sweep (see
 * dead-mp3/dead-mp3-sweep.service.ts for the actual logic, which now also
 * runs automatically every 5 minutes via DeadMp3SweepCronService - this
 * CLI remains for ad-hoc runs, e.g. testing a change or forcing a run with
 * a bigger limit than the cron's default). Shares the same resume state
 * (dead-mp3-sweep-state.json) as the cron - whichever ran most recently is
 * where the other picks up from.
 *
 * Usage:
 *   npm run strip-dead-mp3-batch -- [--limit N] [--no-add-link] [--dry-run]
 *     --limit: how many posts to CHECK before stopping (default 250).
 *     --no-add-link: skip the YouTube/Spotify lookup and insert no
 *       replacement link (the cron always adds one; this CLI defaults to
 *       adding one too, unless this flag is passed).
 *     --dry-run: logs what would change, saves NOTHING - not even the
 *       resume cursor, so a dry-run never advances progress.
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { DeadMp3SweepService } from "./dead-mp3/dead-mp3-sweep.service";

async function run() {
  const flags = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const addLink = !flags.includes("--no-add-link");
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : 250;

  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const sweep = app.get(DeadMp3SweepService);

  console.log(`Running sweep: limit ${limit}, addLink ${addLink}, dryRun ${dryRun}`);
  const result = await sweep.runSweep(limit, addLink, dryRun);
  console.log(
    `\nRun done: checked ${result.checked}, fixed ${result.fixed}, failed ${result.failed}.` +
      (dryRun ? " [DRY RUN - nothing written, resume cursor NOT advanced]" : ""),
  );

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
