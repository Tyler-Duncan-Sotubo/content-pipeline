/**
 * One-off: appends an additional real-content paragraph to an
 * /artists/{letter}/ page, right after the existing intro paragraph
 * (which itself sits after the A-Z grid).
 *
 * Usage:
 *   npm run append-letter-paragraph -- d --dry-run
 *   npm run append-letter-paragraph -- d
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";

const ADDITIONAL_PARAGRAPHS: Record<string, string> = {
  d: `<p>Also on tooXclusive: veteran Afrobeats star <a href="https://tooxclusive.com/artists/dbanj/">D'banj</a>, one of Nigeria's most influential hitmakers; South African producer/DJ <a href="https://tooxclusive.com/artists/dj-maphorisa/">DJ Maphorisa</a>; and Mavin in-house DJ <a href="https://tooxclusive.com/artists/dj-tunez/">DJ Tunez</a>.</p>`,
};

async function run() {
  const letter = process.argv[2]?.toLowerCase();
  const dryRun = process.argv.includes("--dry-run");

  if (!letter || !ADDITIONAL_PARAGRAPHS[letter]) {
    console.error(`Usage: npm run append-letter-paragraph -- <letter> [--dry-run]`);
    console.error(`Available letters: ${Object.keys(ADDITIONAL_PARAGRAPHS).join(", ")}`);
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

  // Find the existing intro paragraph (starts with "Explore artists
  // starting with the letter X") and append the new paragraph right after
  // its closing </p>.
  const introRegex = new RegExp(
    `(<p>Explore artists starting with the letter ${letter.toUpperCase()}[\\s\\S]*?<\\/p>)`,
  );
  const match = rawContent.match(introRegex);
  if (!match) {
    console.error(`Could not find the existing intro paragraph for letter "${letter}" - aborting.`);
    await app.close();
    process.exit(1);
  }

  const additional = ADDITIONAL_PARAGRAPHS[letter];
  const newContent = rawContent.replace(match[1], `${match[1]}\n${additional}`);

  console.log(`[${dryRun ? "dry-run" : "write"}] Page ${page.id} (${page.link})`);
  console.log(`Appending paragraph (${additional.length} chars) after the existing intro.`);
  console.log(`\nNew paragraph:\n${additional}\n`);

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
