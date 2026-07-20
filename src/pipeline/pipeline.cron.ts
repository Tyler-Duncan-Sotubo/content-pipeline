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

  // Tanzania (djmwanga.com) - daily at 08:00 server time
  // Commented out for now while backfilling gospel - re-enable when done.
  // @Cron("0 8 * * *", { name: "pipeline-tz" })
  async runTanzania(): Promise<void> {
    this.logger.log("Cron: starting Tanzania run");
    try {
      const summary = await this.pipeline.run();
      this.logger.log(`Cron: Tanzania run done - ${JSON.stringify(summary)}`);
    } catch (err) {
      this.logger.error(`Cron: Tanzania run failed: ${(err as Error).message}`);
    }
  }

  // Gospel (ceenaija.com) - every 10 minutes for backfill. Switch back to
  // "0 9 * * *" (once daily) once the backlog is cleared.
  @Cron("*/10 * * * *", { name: "pipeline-gospel" })
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
