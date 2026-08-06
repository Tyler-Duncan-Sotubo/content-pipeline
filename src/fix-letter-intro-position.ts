/**
 * One-off fix: the intro paragraph inserted by add-artist-letter-intro.ts
 * was placed ABOVE the A-Z grid; it should be BELOW it instead. Moves the
 * paragraph from right before [vc_raw_html] to right after the grid's
 * closing [/vc_raw_html][/vc_column][/vc_row] sequence, without touching
 * anything else in the page.
 *
 * Usage:
 *   npm run fix-letter-intro-position -- d --dry-run
 *   npm run fix-letter-intro-position -- d
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";

async function run() {
  const letter = process.argv[2]?.toLowerCase();
  const dryRun = process.argv.includes("--dry-run");

  if (!letter) {
    console.error("Usage: npm run fix-letter-intro-position -- <letter> [--dry-run]");
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

  // Find the intro paragraph we inserted (a <p> immediately before [vc_raw_html])
  const introMatch = rawContent.match(/(<p>Explore artists starting with the letter [A-Z][\s\S]*?<\/p>)\s*(?=<p>\[vc_raw_html\])/);
  if (!introMatch) {
    console.error("Could not find the intro paragraph immediately before [vc_raw_html] - it may already be moved, or the structure differs.");
    await app.close();
    process.exit(1);
  }
  const introParagraph = introMatch[1];

  const gridCloseMarker = "[/vc_raw_html][/vc_column][/vc_row]";
  if (!rawContent.includes(gridCloseMarker)) {
    console.error(`Expected marker "${gridCloseMarker}" not found - aborting.`);
    await app.close();
    process.exit(1);
  }

  // Remove the paragraph from its current spot (above the grid)...
  let newContent = rawContent.replace(introMatch[0], "");
  // ...and re-insert it right after the grid's closing sequence.
  newContent = newContent.replace(gridCloseMarker, `${gridCloseMarker}${introParagraph}`);

  console.log(`[${dryRun ? "dry-run" : "write"}] Page ${page.id} (${page.link})`);
  console.log(`Moving intro paragraph (${introParagraph.length} chars) to below the A-Z grid.`);

  if (!dryRun) {
    await wordpress.updatePage(page.id, { content: newContent });
    console.log("Saved.");
  } else {
    console.log("[DRY RUN - nothing written]");
  }

  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
