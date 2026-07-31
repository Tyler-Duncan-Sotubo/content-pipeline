import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceService, SourcePost, SourceSiteConfig } from "../source/source.service";
import { GeneratorService, GeneratedArticle } from "../generate/generator.service";
import { WordpressService, WpCredentials } from "../publish/wordpress.service";
import { StateService } from "../state/state.service";
import { LinksService } from "../links/links.service";
import { getCountryConfig, GOSPEL_SOURCE, GHANA_SOURCE, KENYA_SOURCE } from "../countries";

const PLAYER_EMBED_BASE = "https://stream-player-production.up.railway.app/embed";

export interface RunSummary {
  artists: string[];
  found: number;
  fresh: number;
  results: {
    sourceTitle: string;
    status: "published" | "failed" | "duplicate";
    wpLink?: string;
    error?: string;
  }[];
}

interface RunTarget {
  site: SourceSiteConfig;
  artistsFile: string;
  wpCategory: string;
  /** Slug of wpCategory on the destination site, e.g. "kenya" -> /kenya. Used to link the Genre line. */
  wpCategorySlug: string;
  /** Publish under a different WP user/app-password than the default, if set. */
  wpCredentials?: WpCredentials;
}

@Injectable()
export class PipelineService {
  private readonly logger = new Logger(PipelineService.name);
  private readonly maxPerRun: number;
  private readonly lookbackDays: number;
  private readonly excludeLastDays: number;
  private readonly wpUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly source: SourceService,
    private readonly generator: GeneratorService,
    private readonly wordpress: WordpressService,
    private readonly state: StateService,
    private readonly links: LinksService,
  ) {
    this.maxPerRun = Number(config.get("MAX_PER_RUN") ?? 3);
    this.lookbackDays = Number(config.get("LOOKBACK_DAYS") ?? 7);
    this.excludeLastDays = Number(config.get("EXCLUDE_LAST_DAYS") ?? 0);
    this.wpUrl = config.getOrThrow<string>("WP_URL").replace(/\/$/, "");
  }

  /**
   * The LLM writes a plain "<strong>Genre:</strong> X" line in the metadata
   * block (see article.prompt.ts). Rewrite it here to link Genre to this
   * target's category page (e.g. /kenya, /tanzania, /ghana-music) - the LLM
   * can't be trusted to know or format the destination site's real category
   * URLs, so this is done deterministically after generation.
   */
  private linkGenreToCategory(bodyHtml: string, categorySlug: string): string {
    const categoryUrl = `${this.wpUrl}/${categorySlug}`;
    // Genre can be followed by <br> (older posts, when Release Date came
    // after it) or directly by </p> (current posts, since Genre is now the
    // last field in the metadata block - Release Date was removed).
    return bodyHtml.replace(
      /(<strong>Genre:<\/strong>\s*)([^<]+?)(\s*(?:<br|<\/p>))/i,
      (_match, prefix, genreText, suffix) =>
        `${prefix}<a href="${categoryUrl}">${genreText.trim()}</a>${suffix}`,
    );
  }

  /**
   * Links the "<strong>Artist:</strong> X" metadata line to the artist's
   * dedicated tooxclusive.com/artists/{slug}/ page when one exists (see
   * WordpressService.findArtistPage); otherwise falls back to their tag
   * archive page, which resolveTags guarantees exists for every published post.
   */
  private async linkArtistLine(
    bodyHtml: string,
    articleArtist: string,
    credentials: WpCredentials | undefined,
  ): Promise<string> {
    const primaryArtist = articleArtist.split(/\s*(?:ft\.?|feat\.?|featuring|&|,|\bx\b)\s*/i)[0].trim();
    const artistPage = await this.wordpress.findArtistPage(primaryArtist, credentials);
    const artistUrl =
      artistPage?.link ?? `${this.wpUrl}/tag/${primaryArtist.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/`;

    return bodyHtml.replace(
      /(<strong>Artist:<\/strong>\s*)([^<]+?)(\s*<br)/i,
      (_match, prefix, artistText, suffix) =>
        `${prefix}<a href="${artistUrl}">${artistText.trim()}</a>${suffix}`,
    );
  }

  /** The main country-driven target, e.g. Tanzania via djmwanga.com. */
  private countryTarget(): RunTarget {
    const country = getCountryConfig(this.config.get<string>("COUNTRY") ?? "TZ");
    const override = this.config.get<string>("SOURCE_URL");
    return {
      site: {
        baseUrl: override ?? country.sourceUrl,
        lookbackDays: this.lookbackDays,
        excludeLastDays: this.excludeLastDays,
        downloadLinkStyle: country.downloadLinkStyle ?? "download-attr",
      },
      artistsFile: "artists.json",
      wpCategory: country.wpCategory,
      wpCategorySlug: country.wpCategorySlug,
    };
  }

  /** The gospel-specific target, e.g. ceenaija.com. Independent of COUNTRY. */
  private gospelTarget(): RunTarget {
    const gospelUser = this.config.get<string>("WP_USER_GOSPEL");
    const gospelPassword = this.config.get<string>("WP_APP_PASSWORD_GOSPEL");
    return {
      site: {
        baseUrl: GOSPEL_SOURCE.sourceUrl,
        lookbackDays: this.lookbackDays,
        excludeLastDays: this.excludeLastDays,
        downloadLinkStyle: GOSPEL_SOURCE.downloadLinkStyle,
      },
      artistsFile: "artists-gospel.json",
      wpCategory: GOSPEL_SOURCE.wpCategory,
      wpCategorySlug: GOSPEL_SOURCE.wpCategorySlug,
      wpCredentials:
        gospelUser && gospelPassword ? { user: gospelUser, appPassword: gospelPassword } : undefined,
    };
  }

  /** The Ghana-specific target, e.g. ghanasong.org. Independent of COUNTRY. */
  private ghanaTarget(): RunTarget {
    const ghanaUser = this.config.get<string>("WP_USER_GHANA");
    const ghanaPassword = this.config.get<string>("WP_APP_PASSWORD_GHANA");
    return {
      site: {
        baseUrl: GHANA_SOURCE.sourceUrl,
        lookbackDays: this.lookbackDays,
        excludeLastDays: this.excludeLastDays,
        downloadLinkStyle: GHANA_SOURCE.downloadLinkStyle,
      },
      artistsFile: "artists-ghana.json",
      wpCategory: GHANA_SOURCE.wpCategory,
      wpCategorySlug: GHANA_SOURCE.wpCategorySlug,
      wpCredentials:
        ghanaUser && ghanaPassword ? { user: ghanaUser, appPassword: ghanaPassword } : undefined,
    };
  }

  /** The Kenya-specific target, e.g. citimuzik.com. Independent of COUNTRY. */
  private kenyaTarget(): RunTarget {
    const kenyaUser = this.config.get<string>("WP_USER_KENYA");
    const kenyaPassword = this.config.get<string>("WP_APP_PASSWORD_KENYA");
    return {
      site: {
        baseUrl: KENYA_SOURCE.sourceUrl,
        lookbackDays: this.lookbackDays,
        excludeLastDays: this.excludeLastDays,
        downloadLinkStyle: KENYA_SOURCE.downloadLinkStyle,
      },
      artistsFile: "artists-kenya.json",
      wpCategory: KENYA_SOURCE.wpCategory,
      wpCategorySlug: KENYA_SOURCE.wpCategorySlug,
      wpCredentials:
        kenyaUser && kenyaPassword ? { user: kenyaUser, appPassword: kenyaPassword } : undefined,
    };
  }

  private loadArtists(filename: string): string[] {
    const file = join(process.cwd(), filename);
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8")) as string[];
  }

  async preview(): Promise<{ artists: string[]; fresh: SourcePost[] }> {
    const target = this.countryTarget();
    const artists = this.loadArtists(target.artistsFile);
    const posts = await this.source.collectPosts(target.site, artists);
    return { artists, fresh: posts.filter((p) => !this.state.isProcessed(p.id)) };
  }

  run(artistsOverride?: string[], limitOverride?: number): Promise<RunSummary> {
    return this.runTarget(this.countryTarget(), artistsOverride, limitOverride);
  }

  /** Runs the gospel pipeline (ceenaija.com) independently of the country pipeline. */
  runGospel(artistsOverride?: string[], limitOverride?: number): Promise<RunSummary> {
    return this.runTarget(this.gospelTarget(), artistsOverride, limitOverride);
  }

  /** Runs the Ghana pipeline (ghanasong.org) independently of the country pipeline. */
  runGhana(artistsOverride?: string[], limitOverride?: number): Promise<RunSummary> {
    return this.runTarget(this.ghanaTarget(), artistsOverride, limitOverride);
  }

  /** Runs the Kenya pipeline (citimuzik.com) independently of the country pipeline. */
  runKenya(artistsOverride?: string[], limitOverride?: number): Promise<RunSummary> {
    return this.runTarget(this.kenyaTarget(), artistsOverride, limitOverride);
  }

  private async runTarget(
    target: RunTarget,
    artistsOverride?: string[],
    limitOverride?: number,
  ): Promise<RunSummary> {
    const artists = artistsOverride?.length ? artistsOverride : this.loadArtists(target.artistsFile);
    const limit = limitOverride ?? this.maxPerRun;

    const posts = await this.source.collectPosts(target.site, artists);
    const fresh = posts.filter((p) => !this.state.isProcessed(p.id));
    this.logger.log(
      `[${target.site.baseUrl}] Found ${posts.length} posts, ${fresh.length} new (limit ${limit}/run)`
    );

    const summary: RunSummary = { artists, found: posts.length, fresh: fresh.length, results: [] };

    for (const post of fresh.slice(0, limit)) {
      this.logger.log(`Generating article for: ${post.title}`);
      try {
        const article = await this.generator.generateArticle(post);
        article.bodyHtml = this.linkGenreToCategory(article.bodyHtml, target.wpCategorySlug);
        article.bodyHtml = await this.linkArtistLine(article.bodyHtml, article.artist, target.wpCredentials);

        const existing = await this.wordpress.findExistingPost(
          article.artist,
          article.songTitle,
          target.wpCredentials,
        );
        if (existing) {
          this.logger.warn(
            `Skipping "${article.title}" - already exists on WordPress: ${existing.link}`
          );
          this.state.markProcessed(post.id, existing.id);
          summary.results.push({
            sourceTitle: post.title,
            status: "duplicate",
            wpLink: existing.link,
          });
          continue;
        }

        const isVideo = /\bvideo\b/i.test(post.title);

        if (isVideo && !/\bvideo\b/i.test(article.title)) {
          article.title = `VIDEO | ${article.title}`;
        }

        if (post.imageUrl) {
          article.bodyHtml = `<p><img src="${post.imageUrl}" alt="${article.title}" /></p>\n${article.bodyHtml}`;
        }

        const downloadUrl = isVideo
          ? undefined
          : await this.source.findDownloadUrl(post.link, target.site.downloadLinkStyle);
        article.bodyHtml += await this.buildFooter(article, downloadUrl, post.imageUrl, isVideo);
        const result = await this.wordpress.publishArticle(
          article,
          post.imageUrl,
          target.wpCategory,
          target.wpCredentials,
        );
        this.state.markProcessed(post.id, result.id);
        this.logger.log(`${result.status}: "${article.title}" -> ${result.link}`);
        summary.results.push({ sourceTitle: post.title, status: "published", wpLink: result.link });
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error(`Failed for "${post.title}": ${message}`);
        summary.results.push({ sourceTitle: post.title, status: "failed", error: message });
      }
    }

    return summary;
  }

  /**
   * Video posts always get a YouTube link. Otherwise: audio player embed (when we
   * have the source MP3), or a streaming-link fallback (Spotify/YouTube/Audiomack).
   * Appended after "Stream, download, and enjoy below."
   */
  private async buildFooter(
    article: GeneratedArticle,
    downloadUrl?: string,
    imageUrl?: string,
    isVideo?: boolean,
  ): Promise<string> {
    if (isVideo) {
      const youtube = await this.links.findYouTubeLink(article.artist, article.songTitle);
      if (!youtube) return "";
      this.logger.log(`Video post - YouTube link: ${youtube.url}`);
      return `\n${youtube.url}`;
    }

    if (downloadUrl) {
      const params = new URLSearchParams({
        title: article.songTitle,
        artist: article.artist,
        src: downloadUrl,
        download: "true",
      });
      if (imageUrl) params.set("thumb", imageUrl);
      this.logger.log(`Player embed source: ${downloadUrl}`);
      return `\n<iframe src="${PLAYER_EMBED_BASE}?${params.toString()}" width="100%" height="180" frameborder="0"></iframe>`;
    }

    // No MP3 found on the source page - fall back to a plain streaming-service link
    this.logger.warn("No download URL found; falling back to streaming link lookup");
    const link = await this.links.findStreamingLink(article.artist, article.songTitle);
    if (!link) return "";
    this.logger.log(`Streaming link (${link.platform}): ${link.url}`);
    return `\n${link.url}`;
  }
}
