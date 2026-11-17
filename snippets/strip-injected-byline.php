<?php
/**
 * One-time cleanup: strips the "by {author} — {date}" byline marker that
 * the Node freshness pipeline (and its PHP visitor-touch counterpart)
 * injected at the top of post_content over several months. The service
 * that was writing this is no longer running - this just removes what it
 * already left behind, site-wide, for good.
 *
 * Install as a WordPress Code Snippet (PHP). Driven by an external
 * cleanup app (see ../../byline-cleanup) rather than manual browser
 * reloads - that app calls this endpoint repeatedly on a schedule until
 * it reports done, so running this across thousands of posts doesn't
 * mean sitting there reloading a page yourself.
 *
 *   GET /wp-json/tooxc/v1/byline-cleanup?token=YOUR_SECRET
 *
 * Set TOOXC_BYLINE_CLEANUP_TOKEN in wp-config.php (or another snippet
 * that runs first) to a long random string, and give that SAME value to
 * the cleanup app as its BYLINE_CLEANUP_TOKEN env var - this endpoint
 * refuses every request that doesn't present it, since it's otherwise an
 * unauthenticated, unattended-callable route that writes to post_content.
 *
 * Each call processes one batch (200 posts) and returns JSON with
 * progress; the caller decides when to stop (done: true, or a non-200
 * response). Resumable via the tooxc_byline_cleanup_last_id option - a
 * missed/retried call never reprocesses already-cleaned posts.
 *
 * Three safety properties, all deliberate:
 *   - SQL pre-filter uses two plain LIKEs, OR'd: "color: #d32f2f" (the
 *     current styled marker's exact author-link style) and "Last updated:"
 *     (the older plain format this service has also written, per
 *     BYLINE_MARKER_ANYWHERE_REGEX's own comment in the Node code) -
 *     rather than a loose REGEXP on "by\s" alone, which would ALSO match
 *     ordinary article prose starting a <p> with "By ..." (e.g. "By all
 *     accounts, the song..."), pulling those posts into every batch for
 *     no reason even though the real PCRE replace below would correctly
 *     leave them untouched.
 *   - The PCRE replace itself requires "by" to be IMMEDIATELY followed by
 *     a linked <a> tag ("by\s+<a\s"), not just the word "by" followed by
 *     anything. The original BYLINE_MARKER_ANYWHERE_REGEX used live for
 *     months (freshness.service.ts / old-posts-freshness.service.ts) only
 *     required a bare "by\s" - confirmed via testing that this silently
 *     deletes a post's entire first paragraph if it genuinely starts with
 *     "By ..." (e.g. "By all accounts, the collaboration marks..."), since
 *     the non-greedy match then runs to that paragraph's own closing
 *     </p>. The real injected marker always links the author's name, so
 *     requiring "by <a" immediately after the opening <p> catches every
 *     real marker (verified against both the current styled format and
 *     an <em>-wrapped variant) while never matching ordinary prose
 *     (verified against plain "By ..." prose AND prose that happens to
 *     contain "produced by <a>..." mid-sentence, not at the paragraph start).
 *   - Direct $wpdb->update() (not wp_update_post()) so post_date and
 *     post_modified stay exactly as they are, and no save_post/sitemap
 *     ping hooks fire - this is pure content cleanup, not a "the post
 *     changed" event.
 */
add_action( 'rest_api_init', function () {
	register_rest_route(
		'tooxc/v1',
		'/byline-cleanup',
		array(
			'methods'             => 'GET',
			'callback'            => 'tooxc_run_byline_cleanup_batch',
			// Auth happens inside the callback (token check), not here -
			// permission_callback still has to return true/false, but the
			// actual secret comparison is the real gate.
			'permission_callback' => '__return_true',
		)
	);
} );

function tooxc_run_byline_cleanup_batch( WP_REST_Request $request ) {
	$expected_token = defined( 'TOOXC_BYLINE_CLEANUP_TOKEN' ) ? TOOXC_BYLINE_CLEANUP_TOKEN : '';
	$given_token    = (string) $request->get_param( 'token' );

	if ( empty( $expected_token ) || ! hash_equals( $expected_token, $given_token ) ) {
		return new WP_REST_Response( array( 'error' => 'Invalid or missing token.' ), 403 );
	}

	global $wpdb;

	$batch_size = 200;
	$last_id    = (int) get_option( 'tooxc_byline_cleanup_last_id', 0 );

	// TIGHTENED vs. the original BYLINE_MARKER_ANYWHERE_REGEX used live for
	// months: requires "by" to be immediately followed by a linked <a> tag
	// (the real marker always links the author's name), not just a bare
	// "by\s" - the original pattern matches ordinary article prose that
	// genuinely starts a paragraph with "By ..." and deletes it entirely.
	// Still matches the older plain "Last updated: {date}" format too.
	// See file header for the full reasoning and test cases.
	$marker_regex = '/\s*<p(?:\s+style="[^"]*")?>(?:<em>)?(?:Last updated:|by\s+<a\s)[\s\S]*?<\/(?:em><\/p>|p>)\s*/i';

	$posts = $wpdb->get_results(
		$wpdb->prepare(
			"SELECT ID, post_content
			 FROM {$wpdb->posts}
			 WHERE post_type = 'post'
			   AND post_status = 'publish'
			   AND ID > %d
			   AND (post_content LIKE %s OR post_content LIKE %s)
			 ORDER BY ID ASC
			 LIMIT %d",
			$last_id,
			'%color: #d32f2f%',
			'%Last updated:%',
			$batch_size
		)
	);

	if ( empty( $posts ) ) {
		delete_option( 'tooxc_byline_cleanup_last_id' );
		// Delete the leftover visitor-touch meta in its own small batches
		// too, rather than one unbounded query - runs once the main sweep
		// is done, harmless to re-run if some remain.
		$deleted_meta = $wpdb->query( "DELETE FROM {$wpdb->postmeta} WHERE meta_key = '_freshness_visitor_touch_at' LIMIT 1000" );
		return new WP_REST_Response(
			array(
				'done'              => true,
				'scanned'           => 0,
				'cleaned'           => 0,
				'lastId'            => $last_id,
				'visitorMetaDeleted' => (int) $deleted_meta,
			),
			200
		);
	}

	$cleaned_count = 0;
	$scanned_count = count( $posts );
	$highest_id    = $last_id;

	foreach ( $posts as $post ) {
		$highest_id = max( $highest_id, (int) $post->ID );

		$cleaned_content = trim( preg_replace( $marker_regex, "\n", $post->post_content ) );

		if ( $cleaned_content !== $post->post_content ) {
			$wpdb->update(
				$wpdb->posts,
				array( 'post_content' => $cleaned_content ),
				array( 'ID' => (int) $post->ID ),
				array( '%s' ),
				array( '%d' )
			);
			clean_post_cache( (int) $post->ID );
			$cleaned_count++;
		}
	}

	update_option( 'tooxc_byline_cleanup_last_id', $highest_id, false );

	return new WP_REST_Response(
		array(
			'done'    => false,
			'scanned' => $scanned_count,
			'cleaned' => $cleaned_count,
			'lastId'  => $highest_id,
		),
		200
	);
}
