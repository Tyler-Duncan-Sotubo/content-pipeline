import { Module } from "@nestjs/common";
import { FreshnessService } from "./freshness.service";
import { FreshnessCronService } from "./freshness.cron";
import { OldPostsFreshnessService } from "./old-posts-freshness.service";
import { OldPostsFreshnessCronService } from "./old-posts-freshness.cron";
import { WordpressService } from "../publish/wordpress.service";

@Module({
  providers: [
    FreshnessService,
    FreshnessCronService,
    OldPostsFreshnessService,
    OldPostsFreshnessCronService,
    WordpressService,
  ],
  exports: [FreshnessService, OldPostsFreshnessService],
})
export class FreshnessModule {}
