import { Module } from "@nestjs/common";
import { FreshnessService } from "./freshness.service";
import { FreshnessCronService } from "./freshness.cron";
import { WordpressService } from "../publish/wordpress.service";

@Module({
  providers: [FreshnessService, FreshnessCronService, WordpressService],
  exports: [FreshnessService],
})
export class FreshnessModule {}
