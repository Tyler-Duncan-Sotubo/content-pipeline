/**
 * One-off fix: the two intro paragraphs on /artists/{letter}/ pages are
 * currently in their OWN [vc_row], separate from the A-Z grid's row - so
 * they don't inherit that row's styling (full_width stretch, black
 * overlay, -70px top margin). This moves them INSIDE the A-Z grid's
 * existing row instead, right after its [vc_raw_html]...[/vc_raw_html]
 * block and before that row's own [/vc_column][/vc_row], removing the
 * separate row wrapper entirely.
 *
 * Usage:
 *   npm run merge-intro-into-az-row -- d --dry-run
 *   npm run merge-intro-into-az-row -- d
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";

async function run() {
  const letter = process.argv[2]?.toLowerCase();
  const dryRun = process.argv.includes("--dry-run");

  if (!letter) {
    console.error("Usage: npm run merge-intro-into-az-row -- <letter> [--dry-run]");
    process.exit(1);
  }

  process.env.DISABLE_CRONS = "true";
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);

  const page = await wordpress.findPageBySlug(letter);
  if (!page) {
    console.error(`Could not find page with slug "${letter}"`);
    await app.close();
    process.exit(1);
  }

  const { content } = await (
    await fetch(`${process.env.WP_URL}/wp-json/wp/v2/pages/${page.id}?_fields=content`)
  ).json();
  const rawContent: string = content.rendered;

  // Match: end of the A-Z grid's row, start of the second row/column/text
  // wrapper, the two paragraphs, then the end of the column_text/that row.
  // content.rendered comes back HTML-entity-encoded (e.g. ” as &#8221;,
  // ″ as &#8243;), not literal Unicode - match the encoded form directly
  // rather than unescaping first, to avoid a round-trip re-encoding risk.
  const pattern = new RegExp(
    `(\\[/vc_raw_html\\]\\[/vc_column\\]\\[/vc_row\\])` + // end of A-Z grid row
      `\\[vc_row\\]\\[vc_column width=(?:&#8221;|")2/3(?:&#8243;|")\\]\\[vc_column_text\\]` + // start of separate row
      `([\\s\\S]*?)` + // the two paragraphs
      `\\[/vc_column_text\\]`, // end of column_text (leaves the rest of that row/vc_raw_html grid untouched after)
  );

  const match = rawContent.match(pattern);
  if (!match) {
    console.error("Could not find the expected pattern (A-Z grid row end + separate paragraph row) - aborting.");
    await app.close();
    process.exit(1);
  }

  const azRowEnd = match[1]; // "[/vc_raw_html][/vc_column][/vc_row]"
  const paragraphs = match[2].trim(); // the two <p> paragraphs

  // New structure: paragraphs go INSIDE the A-Z row, right before its close.
  const azRowEndWithoutClose = azRowEnd.replace("[/vc_column][/vc_row]", "");
  const replacement = `${azRowEndWithoutClose}${paragraphs}[/vc_column][/vc_row]`;

  const newContent = rawContent.replace(match[0], replacement);

  console.log(`[${dryRun ? "dry-run" : "write"}] Page ${page.id} (${page.link})`);
  console.log("Moving paragraphs inside the A-Z grid's styled row (stretch + black overlay).");

  if (!dryRun) {
    await wordpress.updatePage(page.id, { content: newContent });
    console.log("Saved.");
  } else {
    console.log("[DRY RUN - nothing written]");
    console.log("\nParagraphs that would move:\n", paragraphs);
  }

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
