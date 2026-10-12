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
  // LinksService exported so cli-strip-dead-mp3.ts (and any other code
  // outside this module) can resolve it via app.get(LinksService) against
  // the full AppModule context - without this export, Nest's DI container
  // treats it as private to PipelineModule and throws
  // UnknownElementException for any resolution attempted from outside.
  exports: [LinksService],
})
export class PipelineModule {}
