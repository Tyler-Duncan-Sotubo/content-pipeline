import { Module } from "@nestjs/common";
import { DeadMp3SweepService } from "./dead-mp3-sweep.service";
import { DeadMp3SweepCronService } from "./dead-mp3-sweep.cron";
import { WordpressService } from "../publish/wordpress.service";
import { LinksService } from "../links/links.service";

@Module({
  providers: [DeadMp3SweepService, DeadMp3SweepCronService, WordpressService, LinksService],
  exports: [DeadMp3SweepService],
})
export class DeadMp3Module {}
