<?php
/**
 * Visitor-triggered freshness touch - complements the NestJS pipeline's
 * cron-based freshness rotations (freshness.service.ts / old-posts-
 * freshness.service.ts), which only cover posts in their own indexed
 * pools (specific categories, ID ranges, and per-day capacity limits).
 * This snippet is a catch-all: when a real visitor loads a post whose
 * "by {author} — {date}" byline isn't dated today, it updates that
 * byline for real (a genuine post_content + post_modified write, not a
 * display-only trick), the same way the cron does.
 *
 * Install as a WordPress Code Snippet (PHP, "Run snippet everywhere" /
 * front-end only is fine since the hook already checks is_singular()).
 *
 * Deliberately mirrors the Node service's exact marker format and ad-
 * stripping behavior (see freshness.service.ts and strip-baked-ads.ts) so
 * the two systems never fight each other or leave duplicate markers/ads:
 *   - Same byline HTML shape: <p style="font-size: 0.85em; color: #777;">
 *     by <a href="{author link}" style="color: #d32f2f;">{author}</a>
 *     — {date}</p>
 *   - Same "strip any existing marker anywhere, then prepend fresh one"
 *     approach, using an equivalent regex to the Node side's
 *     BYLINE_MARKER_ANYWHERE_REGEX.
 *   - Same Advanced Ads duplication guard: Advanced Ads' own save hook
 *     re-inserts its ad block on every post save (confirmed live
 *     elsewhere in this pipeline), so any save must strip existing
 *     tooxc-* placement blocks first or they compound on every visit
 *     that triggers a touch.
 *
 * Rate-limited two ways:
 *   - Per-post: at most once per post per 24 hours via post meta
 *     (_freshness_visitor_touch_at) - a popular post being hit by many
 *     visitors in a row doesn't trigger a save on every single pageview.
 *   - Site-wide: at most FRESHNESS_VISITOR_TOUCH_HOURLY_CAP saves per
 *     rolling hour via a transient counter - without this, a traffic burst
 *     that happens to hit many DIFFERENT stale posts in a short window
 *     (e.g. a crawler sweep, or a social-media spike across old content)
 *     could trigger many simultaneous saves with no ceiling, each firing
 *     the full save pipeline (Advanced Ads re-insertion, SEO re-indexing,
 *     cache purges). The per-post gate alone can't catch that case since
 *     it only limits repeats on the SAME post.
 */

// Max visitor-triggered saves allowed per rolling hour, site-wide. Starting
// point to experiment with and tune based on real traffic - the cron
// rotations already prove 250 posts/run is safe for site performance
// (runs in well under 30 minutes with no visible slowdown), so 100/hour
// here has real headroom under that proven-safe pace while still capping
// a true burst/sweep scenario. Just a single constant to adjust.
if ( ! defined( 'FRESHNESS_VISITOR_TOUCH_HOURLY_CAP' ) ) {
	define( 'FRESHNESS_VISITOR_TOUCH_HOURLY_CAP', 100 );
}

// Started as the same 9 category slugs as the Node pipeline's main
// freshness rotation (FreshnessService.CATEGORY_SLUGS); "gospel" was added
// on top of that set deliberately - it's not in the cron's own 9, so this
// snippet's scope is intentionally slightly wider than the cron's here.
// Confirmed live: "gospel" is the real slug (see GOSPEL_SOURCE.
// wpCategorySlug in countries.ts), not assumed from the category name.
if ( ! defined( 'FRESHNESS_VISITOR_TOUCH_CATEGORY_SLUGS' ) ) {
	define(
		'FRESHNESS_VISITOR_TOUCH_CATEGORY_SLUGS',
		array(
			'songs',
			'south-africa',
			'congo',
			'kenya',
			'lyrics',
			'tanzania',
			'ghana-music',
			'zambia',
			'united-kingdom',
			'gospel',
		)
	);
}

add_action( 'template_redirect', function () {
	// Only real front-end single-post views - never admin, REST, feeds,
	// AJAX, or the editor's own preview/autosave requests.
	if ( is_admin() || wp_doing_ajax() || wp_doing_cron() || ! is_singular( 'post' ) ) {
		return;
	}

	$post = get_queried_object();
	if ( ! $post || empty( $post->ID ) ) {
		return;
	}
	$post_id = $post->ID;

	// Category scope check - cheapest gate, so it runs before touching
	// post meta or the hourly counter.
	if ( ! has_category( FRESHNESS_VISITOR_TOUCH_CATEGORY_SLUGS, $post_id ) ) {
		return;
	}

	// Rate limit: skip entirely if this post was visitor-touched within
	// the last 24 hours, regardless of whether its byline date looks
	// stale - avoids re-checking/re-saving the same post on every visit
	// during a traffic spike.
	$last_touch = (int) get_post_meta( $post_id, '_freshness_visitor_touch_at', true );
	if ( $last_touch && ( time() - $last_touch ) < DAY_IN_SECONDS ) {
		return;
	}

	$content = $post->post_content;

	// Africa/Lagos, matching the Node pipeline's timezone for "today".
	$tz        = new DateTimeZone( 'Africa/Lagos' );
	$now       = new DateTime( 'now', $tz );
	$today_str = $now->format( 'F j, Y' ); // e.g. "October 12, 2026" - matches the DATE portion of the Node marker.

	// If a byline marker already exists AND already contains today's
	// date string, the post is already fresh (either the cron touched it
	// today, or a previous visitor already triggered this same check
	// today) - nothing to do. This check is deliberately looser than an
	// exact string match: it only needs today's date substring to appear
	// inside an existing "by ... — ..." marker line.
	if ( preg_match( '/<p[^>]*>(?:<em>)?by\s[\s\S]*?' . preg_quote( $today_str, '/' ) . '[\s\S]*?<\/(?:em><\/p>|p>)/i', $content ) ) {
		// Still record the check so the 24h rate limit applies even when
		// no write was needed - otherwise every visitor on an
		// already-fresh popular post would re-run this preg_match on
		// every single pageview all day.
		update_post_meta( $post_id, '_freshness_visitor_touch_at', time() );
		return;
	}

	// Resolve the post's own real author - never changed, same rule as
	// the Node service. Checked BEFORE the site-wide counter below so a
	// post that can't get a correct byline doesn't waste a counter slot.
	$author_id   = (int) $post->post_author;
	$author_name = get_the_author_meta( 'display_name', $author_id );
	$author_link = get_author_posts_url( $author_id );
	if ( empty( $author_name ) || empty( $author_link ) ) {
		return; // Can't build a correct byline - skip rather than write something wrong.
	}

	// Site-wide hourly cap: counted only once we know this specific post
	// actually needs AND can get a write. Uses a transient as a rolling
	// counter - WP transients auto-expire, so this naturally resets every
	// hour without needing its own cron. get_transient() returning false
	// (expired or never set) is treated as 0.
	$hourly_count = (int) get_transient( 'freshness_visitor_touch_count' );
	if ( $hourly_count >= FRESHNESS_VISITOR_TOUCH_HOURLY_CAP ) {
		return; // Over the site-wide cap for this hour - skip the write, try again on a later visit.
	}
	set_transient( 'freshness_visitor_touch_count', $hourly_count + 1, HOUR_IN_SECONDS );

	// Strip Advanced Ads' baked placement blocks before saving - its own
	// save hook re-inserts exactly one fresh copy on every update, so
	// saving content that already contains one would duplicate it.
	// Mirrors strip-baked-ads.ts's BAKED_AD_REGEX.
	$ad_regex = '/<div id="tooxc-\d+" class="tooxc-[a-z-]+ tooxc-entity-placement[^"]*"[^>]*>[\s\S]*?<\/iframe>(?:<\/p>\s*)?<\/div>\s*/';
	$content  = preg_replace( $ad_regex, '', $content );

	// Strip any existing byline marker (any format this pipeline has ever
	// written), wherever it sits in the body - mirrors
	// BYLINE_MARKER_ANYWHERE_REGEX on the Node side.
	$marker_regex = '/\s*<p(?:\s+style="[^"]*")?>(?:<em>)?(?:Last updated:|by\s)[\s\S]*?<\/(?:em><\/p>|p>)\s*/i';
	$content      = trim( preg_replace( $marker_regex, "\n", $content ) );

	$today_full = $now->format( 'F j, Y \a\t g:i A' ); // date + time, matching the Node side's time-inclusive format.
	$marker      = sprintf(
		'<p style="font-size: 0.85em; color: #777;">by <a href="%s" style="color: #d32f2f;">%s</a> — %s</p>' . "\n",
		esc_url( $author_link ),
		esc_html( $author_name ),
		esc_html( $today_full )
	);

	$updated_content = $marker . $content;

	wp_update_post(
		array(
			'ID'           => $post_id,
			'post_content' => $updated_content,
		)
	);

	update_post_meta( $post_id, '_freshness_visitor_touch_at', time() );
} );
