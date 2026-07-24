import { Module } from "@nestjs/common";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import { AuditCronService } from "./audit.cron";
import { AuditGeneratorService } from "./audit-generator.service";
import { AuditStateService } from "./audit-state.service";
import { WordpressService } from "../publish/wordpress.service";

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditCronService, AuditGeneratorService, AuditStateService, WordpressService],
})
export class AuditModule {}
