/**
 * Creates /artists/{slug}/ profile pages (matching the Burna Boy/Ruger template)
 * for artists from artists-missing-pages.json that don't have one yet.
 *
 * Unlike Burna Boy's page, we deliberately DO NOT include Real Name / Date of
 * Birth / Label in the meta list - we have no verified source for those facts
 * for these artists, and the LLM bio prompt is instructed never to invent them.
 * Genre comes from the LLM (safe - it's describable from the artist's own
 * catalogue, not a specific unverifiable claim like a birthdate).
 *
 * Discography links are real: each artist's existing tooxclusive.com posts are
 * looked up live via WordpressService.findPostsByArtistName rather than guessed.
 *
 * Usage: npm run build:artist-pages -- [--dry-run] [--limit N]
 */
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { WordpressService } from "./publish/wordpress.service";
import { GeneratorService } from "./generate/generator.service";

const ARTISTS_PARENT_PAGE_ID = 465247; // https://tooxclusive.com/artists/

interface MissingArtist {
  name: string;
  href: string;
  img: string;
}

function slugFromHref(href: string): string {
  const parts = href.replace(/\/$/, "").split("/");
  return parts[parts.length - 1];
}

function rosterForArtist(): string {
  // The A-Z card list is Nigerian/African-pop featured artists, not tied to
  // one of the pipeline's regional rosters - use a neutral general context.
  return "General African Pop/Amapiano";
}

function encodeVcRawHtml(raw: string): string {
  return Buffer.from(encodeURIComponent(raw), "utf-8").toString("base64");
}

function buildProfileHeaderHtml(name: string, genre: string, imgUrl: string): string {
  return `<div class="artist-profile">
  <div class="artist-details">
   <div class="artist-return">
      <a href="https://tooxclusive.com/artists/">← Back to All Artists</a>
    </div>
    <h2>${name}</h2>
    <ul class="artist-meta">
      <li><strong>Genre:</strong> ${genre}</li>
    </ul>
  </div>
  <div class="artist-image">
    <img src="${imgUrl}" alt="${name} portrait">
  </div>
</div>`;
}

function buildBioHtml(name: string, intro: string, earlyLife: string, careerHighlights: string): string {
  return `<h2>${name} Bio</h2>
<p>${intro}</p>
<hr />
<h2>Background</h2>
<p>${earlyLife}</p>
<hr />
<h2>Career</h2>
<p>${careerHighlights}</p>`;
}

function buildDiscographyHtml(posts: { link: string; title: string }[]): string {
  if (posts.length === 0) return "";
  const items = posts.map((p) => `<li><a href="${p.link}">${p.title}</a></li>`).join("\n");
  return `<hr />
<h2>Featured On tooXclusive</h2>
<ul>
${items}
</ul>`;
}

function buildPageContent(
  name: string,
  genre: string,
  imgUrl: string,
  bio: { intro: string; earlyLife: string; careerHighlights: string },
  discographyHtml: string,
): string {
  const headerBlock = encodeVcRawHtml(buildProfileHeaderHtml(name, genre, imgUrl));
  const bioText = buildBioHtml(name, bio.intro, bio.earlyLife, bio.careerHighlights) + "\n" + discographyHtml;

  return (
    `[vc_row full_width="stretch_row_content_no_spaces" enable_overlay="yes" vc_row_background="" ` +
    `css=".vc_custom_1771767147496{margin-top: -70px !important;}" overlay_color="#000000"]` +
    `[vc_column][vc_raw_html]${headerBlock}[/vc_raw_html][/vc_column][/vc_row]` +
    `[vc_row vc_row_background=""][vc_column width="2/3"][vc_wp_text]\n${bioText}\n[/vc_wp_text][/vc_column]` +
    `[vc_column width="1/3"][vc_widget_sidebar sidebar_id="home-5"][/vc_column][/vc_row]`
  );
}

const PAGE_META = {
  jnews_page_loop: {
    first_title: "Latest Post",
    header_type: "heading_6",
    layout: "right-sidebar",
    sidebar: "default-sidebar",
    second_sidebar: "default-sidebar",
    sticky_sidebar: "1",
    module: "3",
    main_custom_image_size: "default",
    second_custom_image_size: "default",
    excerpt_length: "20",
    content_date: "default",
    date_custom: "Y/m/d",
    content_pagination: "nav_1",
    pagination_align: "center",
    post_sticky: "0",
    post_offset: "0",
    posts_per_page: "5",
    sort_by: "latest",
  },
  jnews_single_page: {
    layout: "no-sidebar",
    sidebar: "default-sidebar",
    second_sidebar: "default-sidebar",
    sticky_sidebar: "1",
    show_post_title: "0",
    show_post_breadcrumbs: "0",
    show_post_featured: "1",
    share_position: "top",
    share_color: "share-monocrhome",
  },
  footnotes: "",
};

async function run() {
  const flags = process.argv.slice(2);
  const dryRun = flags.includes("--dry-run");
  const limitIdx = flags.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(flags[limitIdx + 1]) : Infinity;

  const file = join(process.cwd(), "artists-missing-pages.json");
  const artists = JSON.parse(readFileSync(file, "utf8")) as MissingArtist[];

  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  const wordpress = app.get(WordpressService);
  const generator = app.get(GeneratorService);

  let created = 0;
  let failed = 0;

  for (const artist of artists.slice(0, limit)) {
    const slug = slugFromHref(artist.href);
    try {
      console.log(`Generating bio for "${artist.name}"...`);
      const bio = await generator.generateArtistBio(artist.name, rosterForArtist());

      console.log(`Searching tooxclusive for existing "${artist.name}" posts...`);
      const posts = await wordpress.findPostsByArtistName(artist.name, 8);
      const discographyHtml = buildDiscographyHtml(posts);

      const content = buildPageContent(artist.name, bio.genre, artist.img, bio, discographyHtml);

      if (dryRun) {
        console.log(
          `[dry-run] Would create /artists/${slug}/ - genre="${bio.genre}", ${posts.length} linked post(s)`,
        );
        console.log(`--- bio preview ---\n${JSON.stringify(bio, null, 2)}\n--- linked posts ---`);
        posts.forEach((p) => console.log(`  ${p.title} -> ${p.link}`));
        console.log("---");
        created++;
        continue;
      }

      const page = await wordpress.createPage({
        title: artist.name,
        slug,
        content,
        parent: ARTISTS_PARENT_PAGE_ID,
        meta: PAGE_META,
      });
      console.log(`Created: ${page.link}`);
      created++;
    } catch (err) {
      console.error(`FAILED for "${artist.name}": ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. Created ${created}, failed ${failed}.` + (dryRun ? " [DRY RUN]" : ""));
  await app.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
