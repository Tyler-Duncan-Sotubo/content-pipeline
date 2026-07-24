import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { AuditedContent, auditArticleSchema, AUDIT_SYSTEM_PROMPT, auditUserPrompt } from "./audit.prompt";

@Injectable()
export class AuditGeneratorService {
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
  }

  rewriteThinArticle(input: {
    artist: string;
    title: string;
    existingText: string;
    wordCount: number;
  }): Promise<AuditedContent> {
    return this.provider === "anthropic" ? this.withAnthropic(input) : this.withOpenAI(input);
  }

  private async withOpenAI(input: Parameters<AuditGeneratorService["rewriteThinArticle"]>[0]) {
    const response = await this.openai!.chat.completions.create({
      model: this.openaiModel,
      messages: [
        { role: "system", content: AUDIT_SYSTEM_PROMPT },
        { role: "user", content: auditUserPrompt(input) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "audited_article", strict: true, schema: auditArticleSchema },
      },
    });
    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned an empty response");
    return JSON.parse(content) as AuditedContent;
  }

  private async withAnthropic(input: Parameters<AuditGeneratorService["rewriteThinArticle"]>[0]) {
    const response = await this.anthropic!.messages.create({
      model: this.anthropicModel,
      max_tokens: 16000,
      system: AUDIT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: auditUserPrompt(input) }],
      output_config: {
        format: { type: "json_schema", schema: auditArticleSchema as unknown as Record<string, unknown> },
      },
    });
    const block = response.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") throw new Error("Anthropic returned an empty response");
    return JSON.parse(block.text) as AuditedContent;
  }
}
