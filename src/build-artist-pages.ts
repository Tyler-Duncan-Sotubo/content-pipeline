/**
 * Creates /artists/{slug}/ profile pages matching the real template
 * (e.g. Fireboy DML, Burna Boy) for artists from artists-missing-pages.json
 * that don't have one yet.
 *
 * Bio facts (real name, DOB, hometown, label) and discography (real
 * albums/tracks) are sourced from the LLM's own knowledge of the artist -
 * the prompt instructs it to state a specific fact only when confident, and
 * leave it blank rather than invent one.
 *
 * The right column uses the same three jnews_block widgets as every other
 * artist page: Latest Songs, Latest News, Lyrics - scoped to this artist via
 * their real WordPress tag IDs (resolved/created via resolveTagsOnly, same
 * as the main pipeline uses for song posts) plus their "{Name} News" tag.
 * Category IDs (Songs/A-List/HOT!!/News/Lyrics) are fixed site-wide values,
 * confirmed against Fireboy DML's live page.
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
import { DiscographyAlbum, GeneratedArtistBio } from "./generate/artist-bio.prompt";

const ARTISTS_PARENT_PAGE_ID = 465247; // https://tooxclusive.com/artists/

// Confirmed live from Fireboy DML's page (id 465247's children use the same fixed IDs)
const CATEGORY_SONGS = 1; // Songs
const CATEGORY_A_LIST = 69188; // A-List
const CATEGORY_HOT = 30461; // HOT!!
const CATEGORY_NEWS = 817; // News
const CATEGORY_LYRICS = 3632; // Lyrics

interface MissingArtist {
  name: string;
  href: string;
  img: string;
}

function slugFromHref(href: string): string {
  const parts = href.replace(/\/$/, "").split("/");
  return parts[parts.length - 1];
}

function encodeVcRawHtml(raw: string): string {
  return Buffer.from(encodeURIComponent(raw), "utf-8").toString("base64");
}

function metaListItem(label: string, value: string): string {
  return value ? `      <li><strong>${label}:</strong> ${value}</li>\n` : "";
}

function buildProfileHeaderHtml(name: string, bio: GeneratedArtistBio, imgUrl: string): string {
  const metaItems =
    metaListItem("Real Name", bio.realName) +
    metaListItem("Alias Name", bio.aliasName) +
    metaListItem("Date of Birth", bio.dateOfBirth) +
    metaListItem("Hometown", bio.hometown) +
    metaListItem("Label", bio.label) +
    metaListItem("Genre", bio.genre);

  return `<div class="artist-profile">
  <div class="artist-details">
    <div class="artist-return">
      <a href="https://tooxclusive.com/artists/">← Back To Artists</a>
    </div>

    <h2>${name}</h2>
    <ul class="artist-meta">
${metaItems}    </ul>
  </div>

  <div class="artist-image">
    <img src="${imgUrl}" alt="${name} portrait" />
  </div>
</div>`;
}

function buildDiscographyHtml(albums: DiscographyAlbum[]): string {
  if (albums.length === 0) return "";
  const blocks = albums
    .map((album) => {
      const trackList = album.tracks.map((t) => `\n${t}`).join("");
      return `${album.title} (${album.year})${trackList}\n`;
    })
    .join("\n");
  return `\n${blocks}`;
}

function buildPageContent(
  name: string,
  bio: GeneratedArtistBio,
  imgUrl: string,
  songTagId: number | undefined,
  newsTagId: number | undefined,
): string {
  const headerBlock = encodeVcRawHtml(buildProfileHeaderHtml(name, bio, imgUrl));
  const discographyText = buildDiscographyHtml(bio.discography);

  const songTags = [songTagId, newsTagId].filter(Boolean).join(",");
  const newsTags = [songTagId, newsTagId].filter(Boolean).join(",");

  return (
    `[vc_row full_width="stretch_row_content_no_spaces" enable_overlay="yes" vc_row_background="" ` +
    `css=".vc_custom_1771976788010{margin-top: -70px !important;}" overlay_color="#000000"]` +
    `[vc_column][vc_raw_html]${headerBlock}[/vc_raw_html][/vc_column][/vc_row]` +
    `[vc_row][vc_column width="2/3"][vc_wp_text title="${name} Bio"]\n\n${bio.bioHtml}\n\n[/vc_wp_text]` +
    `[vc_separator]` +
    `[jnews_block_21 compatible_column_notice="" sticky_post="" sponsor="" number_post="6" post_offset="0" ` +
    `included_only="" include_category="${CATEGORY_SONGS},${CATEGORY_A_LIST},${CATEGORY_HOT}" ` +
    `exclude_category="${CATEGORY_NEWS},${CATEGORY_LYRICS}" include_tag="${songTags}" ` +
    `exclude_visited_post="" first_title="Latest Songs"]` +
    `[vc_separator]` +
    `[jnews_block_9 compatible_column_notice="" sticky_post="" sponsor="" number_post="4" post_offset="0" ` +
    `included_only="" include_category="${CATEGORY_NEWS}" include_tag="${newsTags}" ` +
    `exclude_visited_post="" first_title="Latest News"]` +
    `[vc_separator]` +
    `[jnews_block_22 compatible_column_notice="" sticky_post="" sponsor="" number_post="6" post_offset="0" ` +
    `included_only="" include_category="${CATEGORY_LYRICS}" include_tag="${songTags}" ` +
    `exclude_visited_post="" first_title="Lyrics"][/vc_column]` +
    `[vc_column width="1/3"][vc_wp_text title="Discography"]\n${discographyText}\n[/vc_wp_text][/vc_column][/vc_row]`
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
      const bio = await generator.generateArtistBio(artist.name);

      console.log(`Resolving tags for "${artist.name}"...`);
      const [songTagIds, newsTagIds] = await Promise.all([
        wordpress.resolveTagsOnly([artist.name]),
        wordpress.resolveTagsOnly([`${artist.name} News`]),
      ]);
      const songTagId = songTagIds[0];
      const newsTagId = newsTagIds[0];

      const content = buildPageContent(artist.name, bio, artist.img, songTagId, newsTagId);

      const existing = await wordpress.findPageBySlug(slug);

      if (dryRun) {
        console.log(
          `[dry-run] Would ${existing ? "update" : "create"} /artists/${slug}/ - genre="${bio.genre}", ` +
            `${bio.discography.length} album(s), songTag=${songTagId}, newsTag=${newsTagId}`,
        );
        console.log(`--- bio preview ---\n${JSON.stringify(bio, null, 2)}\n---`);
        created++;
        continue;
      }

      if (existing) {
        const page = await wordpress.updatePage(existing.id, { content, meta: PAGE_META });
        console.log(`Updated: ${page.link}`);
      } else {
        const page = await wordpress.createPage({
          title: artist.name,
          slug,
          content,
          parent: ARTISTS_PARENT_PAGE_ID,
          meta: PAGE_META,
        });
        console.log(`Created: ${page.link}`);
      }
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
