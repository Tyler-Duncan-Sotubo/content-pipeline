// One-shot run without starting the HTTP server: npm run pipeline
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { PipelineService } from "./pipeline/pipeline.service";

async function run() {
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const pipeline = app.get(PipelineService);
  const summary = await pipeline.run();
  console.log(JSON.stringify(summary, null, 2));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
