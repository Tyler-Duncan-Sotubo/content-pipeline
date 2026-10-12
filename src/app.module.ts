import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { PipelineModule } from "./pipeline/pipeline.module";
import { FreshnessModule } from "./freshness/freshness.module";
import { EntertainmentModule } from "./entertainment/entertainment.module";
import { DeadMp3Module } from "./dead-mp3/dead-mp3.module";
import { LoggerModule } from "./logger/logger.module";
import { validateEnv } from "./env.validation";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    LoggerModule,
    PipelineModule,
    FreshnessModule,
    EntertainmentModule,
    DeadMp3Module,
  ],
})
export class AppModule {}
