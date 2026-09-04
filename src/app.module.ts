import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { PipelineModule } from "./pipeline/pipeline.module";
import { FreshnessModule } from "./freshness/freshness.module";
import { EntertainmentModule } from "./entertainment/entertainment.module";
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
  ],
})
export class AppModule {}
