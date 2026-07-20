import { Module } from "@nestjs/common";
import { PipelineController } from "./pipeline.controller";
import { PipelineService } from "./pipeline.service";
import { PipelineCronService } from "./pipeline.cron";
import { SourceService } from "../source/source.service";
import { GeneratorService } from "../generate/generator.service";
import { WordpressService } from "../publish/wordpress.service";
import { StateService } from "../state/state.service";
import { LinksService } from "../links/links.service";

@Module({
  controllers: [PipelineController],
  providers: [
    PipelineService,
    PipelineCronService,
    SourceService,
    GeneratorService,
    WordpressService,
    StateService,
    LinksService,
  ],
})
export class PipelineModule {}
