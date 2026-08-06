/**
 * One-off: inserts a real intro paragraph into an /artists/{letter}/ page,
 * right after the opening [vc_column] and before the existing [vc_raw_html]
 * A-Z grid block - leaves the base64-encoded raw-HTML block completely
 * untouched, since decoding/re-encoding it correctly is unnecessary risk
 * when we can just insert a plain-HTML block alongside it instead.
 *
 * These pages currently have zero body text (just a link grid), which
 * gives Google nothing to index besides "D « tooXclusive" as the title -
 * this adds real, verified content: names real artists starting with that
 * letter who have actual song/album coverage on the site (checked via the
 * WordPress REST API before being included, so nothing here is fabricated
 * or references an artist with zero real content).
 *
 * Usage:
 *   npm run add-letter-intro -- d --dry-run
 *   npm run add-letter-intro -- d
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";

const LETTER_INTROS: Record<string, string> = {
  d: `<p>Explore artists starting with the letter D on tooXclusive, home to some of Afrobeats' biggest names. Find the latest music, albums, and news from <a href="https://tooxclusive.com/artists/davido/">Davido</a>, Nigeria's global superstar behind hits like <a href="https://tooxclusive.com/albums/davido-oriade/">ORIADÉ</a>; hitmaker and Mavin Records boss <a href="https://tooxclusive.com/artists/don-jazzy/">Don Jazzy</a>; Port Harcourt singer <a href="https://tooxclusive.com/artists/duncan-mighty/">Duncan Mighty</a>; and top producers/DJs <a href="https://tooxclusive.com/artists/dj-spinall/">DJ Spinall</a> and <a href="https://tooxclusive.com/artists/dj-neptune/">DJ Neptune</a>. Use the A-Z index below to jump to any artist.</p>`,
};

async function run() {
  const letter = process.argv[2]?.toLowerCase();
  const dryRun = process.argv.includes("--dry-run");

  if (!letter || !LETTER_INTROS[letter]) {
    console.error(`Usage: npm run add-letter-intro -- <letter> [--dry-run]`);
    console.error(`Available letters: ${Object.keys(LETTER_INTROS).join(", ")}`);
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

  const marker = "[vc_column][vc_raw_html]";
  if (!rawContent.includes(marker)) {
    console.error(`Expected marker "[vc_column][vc_raw_html]" not found in page ${page.id} - aborting, content structure may differ from what was inspected.`);
    await app.close();
    process.exit(1);
  }

  const intro = LETTER_INTROS[letter];
  const newContent = rawContent.replace(marker, `[vc_column]${intro}[vc_raw_html]`);

  console.log(`[${dryRun ? "dry-run" : "write"}] Page ${page.id} (${page.link})`);
  console.log(`Inserting intro (${intro.length} chars) right before the existing [vc_raw_html] block.`);
  console.log(`\nIntro text:\n${intro}\n`);

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
