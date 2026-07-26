import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { SourcePost } from "../source/source.service";
import { GeneratedArticle, articleSchema, SYSTEM_PROMPT, userPrompt } from "./article.prompt";
import {
  GeneratedArtistBio,
  artistBioSchema,
  ARTIST_BIO_SYSTEM_PROMPT,
  artistBioUserPrompt,
} from "./artist-bio.prompt";

export { GeneratedArticle } from "./article.prompt";
export { GeneratedArtistBio } from "./artist-bio.prompt";

@Injectable()
export class GeneratorService {
  private readonly logger = new Logger(GeneratorService.name);
  private readonly provider: "openai" | "anthropic";
  private readonly openai?: OpenAI;
  private readonly anthropic?: Anthropic;
  private readonly openaiModel: string;
  private readonly anthropicModel: string;

  constructor(config: ConfigService) {
    this.provider = (config.get<string>("PROVIDER") ?? "openai") as "openai" | "anthropic";
    this.openaiModel = config.get<string>("OPENAI_MODEL") ?? "gpt-4o-mini";
    this.anthropicModel = config.get<string>("ANTHROPIC_MODEL") ?? "claude-sonnet-5";

    if (this.provider === "anthropic") {
      this.anthropic = new Anthropic({ apiKey: config.getOrThrow<string>("ANTHROPIC_API_KEY") });
    } else {
      this.openai = new OpenAI({ apiKey: config.getOrThrow<string>("OPENAI_API_KEY") });
    }
    this.logger.log(`Using ${this.provider} for article generation`);
  }

  generateArticle(post: SourcePost): Promise<GeneratedArticle> {
    return this.provider === "anthropic"
      ? this.generateWithAnthropic(post)
      : this.generateWithOpenAI(post);
  }

  private async generateWithOpenAI(post: SourcePost): Promise<GeneratedArticle> {
    const response = await this.openai!.chat.completions.create({
      model: this.openaiModel,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(post) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "article", strict: true, schema: articleSchema },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response");
    return JSON.parse(content) as GeneratedArticle;
  }

  private async generateWithAnthropic(post: SourcePost): Promise<GeneratedArticle> {
    const response = await this.anthropic!.messages.create({
      model: this.anthropicModel,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt(post) }],
      output_config: {
        format: { type: "json_schema", schema: articleSchema as unknown as Record<string, unknown> },
      },
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned an empty response");
    return JSON.parse(block.text) as GeneratedArticle;
  }

  generateArtistBio(artistName: string, roster: string): Promise<GeneratedArtistBio> {
    return this.provider === "anthropic"
      ? this.generateBioWithAnthropic(artistName, roster)
      : this.generateBioWithOpenAI(artistName, roster);
  }

  private async generateBioWithOpenAI(artistName: string, roster: string): Promise<GeneratedArtistBio> {
    const response = await this.openai!.chat.completions.create({
      model: this.openaiModel,
      messages: [
        { role: "system", content: ARTIST_BIO_SYSTEM_PROMPT },
        { role: "user", content: artistBioUserPrompt(artistName, roster) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "artist_bio", strict: true, schema: artistBioSchema },
      },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response");
    return JSON.parse(content) as GeneratedArtistBio;
  }

  private async generateBioWithAnthropic(artistName: string, roster: string): Promise<GeneratedArtistBio> {
    const response = await this.anthropic!.messages.create({
      model: this.anthropicModel,
      max_tokens: 4000,
      system: ARTIST_BIO_SYSTEM_PROMPT,
      messages: [{ role: "user", content: artistBioUserPrompt(artistName, roster) }],
      output_config: {
        format: { type: "json_schema", schema: artistBioSchema as unknown as Record<string, unknown> },
      },
    });

    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned an empty response");
    return JSON.parse(block.text) as GeneratedArtistBio;
  }
}
