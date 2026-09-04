import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { EntertainmentService } from "./entertainment.service";

/**
 * Entertainment aggregation, hourly at :30 between 08:30 and 22:30 Lagos.
 *
 * Each run costs two feed requests (one per source) plus one article fetch
 * per story that actually matches a tracked artist - matching happens on the
 * feed data first, so unmatched stories cost nothing. That keeps the load on
 * both third-party sites low, which matters: heavy scanning during
 * development provoked sustained 504s from one of them.
 *
 * Per-run limit is deliberately small. Only a fraction of either feed names a
 * tracked artist, so a low cap is rarely the binding constraint - but it does
 * stop a busy news day turning into a wall of near-identical posts.
 */
@Injectable()
export class EntertainmentCronService {
  private readonly logger = new Logger(EntertainmentCronService.name);
  private isRunning = false;

  constructor(private readonly entertainment: EntertainmentService) {}

  // Hourly at :30 rather than on the hour - every other cron in this app
  // fires at the top of the hour, so this keeps the two sets of API calls
  // (and their WordPress writes) from landing at the same moment.
  // 08:30-22:30 Lagos: outside those hours the sources publish little and
  // there's no point polling them.
  @Cron("30 8-22 * * *", { name: "entertainment-aggregate", timeZone: "Africa/Lagos" })
  async run(): Promise<void> {
    if (process.env.DISABLE_CRONS === "true") return;
    if (this.isRunning) {
      this.logger.warn("Cron: entertainment run still in progress - skipping this trigger");
      return;
    }
    this.isRunning = true;
    this.logger.log("Cron: starting entertainment aggregation");
    try {
      const result = await this.entertainment.runOnce(3);
      this.logger.log(`Cron: entertainment run done - ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Cron: entertainment run failed: ${(err as Error).message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
