import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { ScheduleModule } from "@nestjs/schedule";
import { PipelineModule } from "./pipeline/pipeline.module";
import { AuditModule } from "./audit/audit.module";
import { LoggerModule } from "./logger/logger.module";
import { validateEnv } from "./env.validation";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ScheduleModule.forRoot(),
    LoggerModule,
    PipelineModule,
    AuditModule,
  ],
})
export class AppModule {}
