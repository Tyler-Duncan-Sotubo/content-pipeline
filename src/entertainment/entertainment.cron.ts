import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { EntertainmentService } from "./entertainment.service";

/**
 * Entertainment aggregation runs a few times a day rather than hourly: the
 * source publishes a lot, but only a small fraction names a tracked artist
 * (measured at roughly 4 in 11 of the music-adjacent headlines, and far less
 * of the feed overall), so hourly polling would mostly be wasted requests
 * against a third-party site that has already shown it will 504 under load.
 */
@Injectable()
export class EntertainmentCronService {
  private readonly logger = new Logger(EntertainmentCronService.name);
  private isRunning = false;

  constructor(private readonly entertainment: EntertainmentService) {}

  @Cron("30 8,12,16,20 * * *", { name: "entertainment-aggregate", timeZone: "Africa/Lagos" })
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
