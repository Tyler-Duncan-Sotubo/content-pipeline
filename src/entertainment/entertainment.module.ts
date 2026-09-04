import { Module } from "@nestjs/common";
import { EntertainmentService } from "./entertainment.service";
import { EntertainmentCronService } from "./entertainment.cron";
import { GeneratorService } from "../generate/generator.service";
import { WordpressService } from "../publish/wordpress.service";

@Module({
  providers: [EntertainmentService, EntertainmentCronService, GeneratorService, WordpressService],
  exports: [EntertainmentService],
})
export class EntertainmentModule {}
