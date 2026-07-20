import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PipelineService } from "./pipeline.service";

/**
 * Runs both pipelines on a schedule inside this process. Only active when the
 * app is kept running (npm run start / start:dev) - a one-shot `npm run
 * pipeline` invocation exits before any cron would fire.
 */
@Injectable()
export class PipelineCronService {
  private readonly logger = new Logger(PipelineCronService.name);

  constructor(private readonly pipeline: PipelineService) {}

  // Tanzania (djmwanga.com) - 4x/day at 9am, 1pm, 5pm, 9pm WAT (Nigeria time),
  // timed around djmwanga's own posting bursts and Nigerian audience active hours.
  // Commented out for now while backfilling gospel - re-enable when done.
  // @Cron("0 9,13,17,21 * * *", { name: "pipeline-tz", timeZone: "Africa/Lagos" })
  async runTanzania(): Promise<void> {
    this.logger.log("Cron: starting Tanzania run");
    try {
      const summary = await this.pipeline.run();
      this.logger.log(`Cron: Tanzania run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: Tanzania run failed: ${(err as Error).message}`);
    }
  }

  // Gospel (ceenaija.com) - every 10 minutes for backfill. Once the backlog is
  // cleared, switch to 3x/day: "0 12,16,20 * * *" (noon, 4pm, 8pm WAT) - right
  // after ceenaija's morning posting burst, plus afternoon/evening catch-up.
  @Cron("*/10 * * * *", { name: "pipeline-gospel", timeZone: "Africa/Lagos" })
  async runGospel(): Promise<void> {
    this.logger.log("Cron: starting gospel run");
    try {
      const summary = await this.pipeline.runGospel();
      this.logger.log(`Cron: gospel run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: gospel run failed: ${(err as Error).message}`);
    }
  }
}
