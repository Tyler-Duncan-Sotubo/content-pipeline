import { Body, Controller, Get, Post } from "@nestjs/common";
import { PipelineService, RunSummary } from "./pipeline.service";

@Controller("pipeline")
export class PipelineController {
  constructor(private readonly pipeline: PipelineService) {}

  /**
   * Trigger a run. Optionally override the artist triggers for this run:
   * POST /pipeline/run  { "artists": ["Diamond Platnumz"], "limit": 2 }
   */
  @Post("run")
  run(@Body() body: { artists?: string[]; limit?: number }): Promise<RunSummary> {
    return this.pipeline.run(body?.artists, body?.limit);
  }

  /** Preview which source posts would be processed, without generating anything. */
  @Get("preview")
  preview() {
    return this.pipeline.preview();
  }

  /**
   * Trigger a gospel run (ceenaija.com), independent of the country pipeline.
   * POST /pipeline/run-gospel  { "artists": ["Mercy Chinwo"], "limit": 2 }
   */
  @Post("run-gospel")
  runGospel(@Body() body: { artists?: string[]; limit?: number }): Promise<RunSummary> {
    return this.pipeline.runGospel(body?.artists, body?.limit);
  }
}
