<?php
/**
 * Sitemap paged-404 reproduction seed.
 *
 * Reproduces the WordPress core bug where a paginated core XML sitemap sub-page
 * (wp-sitemap-posts-<cpt>-N.xml) is served with HTTP 404 once N exceeds the
 * blog (`post`) sitemap page count, even though WP_Sitemaps would render valid
 * XML for that page. Originally surfaced on extrachill.com via the
 * data-machine-events plugin (Extra-Chill/data-machine-events#334), but this
 * recipe proves the behavior is CORE: it uses a plain public CPT and a shared
 * taxonomy with NONE of that plugin's 404-prevention hooks.
 *
 * Root cause (WP 7.0):
 *   wp-sitemap-posts-<cpt>-N.xml rewrites to
 *     index.php?sitemap=posts&sitemap-subtype=<cpt>&paged=N
 *   with NO post_type query var. The dummy MAIN WP_Query defaults to the `post`
 *   post type at the site's posts_per_page. WP::main() (wp-includes/class-wp.php)
 *   calls handle_404() against that main query on the `wp` action, BEFORE
 *   WP_Sitemaps::render_sitemaps() runs on template_redirect. Once `paged`
 *   exceeds the blog post page count, the main query returns zero posts and core
 *   flags is_404() -> status_header(404), stamping a 404 on a response whose
 *   body is a valid <urlset>.
 *
 * This seed registers the shared CPT + taxonomy, seeds a boundary condition
 * where the blog sitemap has FEWER pages than the CPT/taxonomy sitemap, then
 * drives the real core request lifecycle for each sitemap sub-page URL and
 * reports the resulting HTTP status + is_404 as JSON.
 *
 * Run after wp-load.php (the recipe uses wordpress.run-php).
 */

if ( ! defined( 'ABSPATH' ) ) {
	fwrite( STDERR, "sitemap-paged-404-repro-seed: no ABSPATH\n" );
	exit( 1 );
}

/* 1. Register a public CPT + a taxonomy shared on BOTH `post` and the CPT.
 *    NO pre_get_posts / wp / pre_handle_404 hooks: pure vanilla behavior. */
register_post_type( 'repro_event', array(
	'public'      => true,
	'label'       => 'Repro Events',
	'has_archive' => true,
	'rewrite'     => array( 'slug' => 'repro-event' ),
	'taxonomies'  => array( 'repro_artist' ),
) );
register_taxonomy( 'repro_artist', array( 'post', 'repro_event' ), array(
	'public'       => true,
	'label'        => 'Repro Artists',
	'hierarchical' => false,
	'rewrite'      => array( 'slug' => 'repro-artist' ),
) );

/* Shrink sitemap page size so the CPT/taxonomy sitemaps advertise multiple
 * pages with a modest seed. This does NOT change the mechanism: the 404
 * boundary is driven by the MAIN query's posts_per_page (blog page count). */
add_filter( 'wp_sitemaps_max_urls', static function () {
	return 50;
} );

/* 2. Pretty permalinks + tiny blog page size, then flush rewrites so sitemap
 *    routes resolve. */
update_option( 'permalink_structure', '/%postname%/' );
update_option( 'posts_per_page', 5 );

global $wp_rewrite;
$wp_rewrite->init();
$wp_rewrite->set_permalink_structure( '/%postname%/' );
$wp_rewrite->flush_rules( false );

/* 3. Seed the boundary condition.
 *    blog: 6 posts / 5 per page   = 2 main-query pages   -> 404 boundary at page 3
 *    CPT : 120 posts / 50 max_urls = 3 CPT sitemap pages  (pages 1,2,3)
 *    So CPT/taxonomy page 3 has paged(3) > blog page count(2): the bug zone. */
$term    = wp_insert_term( 'Test Artist', 'repro_artist', array( 'slug' => 'test-artist' ) );
$term_id = is_wp_error( $term )
	? (int) get_term_by( 'slug', 'test-artist', 'repro_artist' )->term_id
	: (int) $term['term_id'];

for ( $i = 1; $i <= 6; $i++ ) {
	wp_insert_post( array(
		'post_type'   => 'post',
		'post_status' => 'publish',
		'post_title'  => "Blog Post $i",
		'post_name'   => "blog-post-$i",
	) );
}
for ( $i = 1; $i <= 120; $i++ ) {
	$pid = wp_insert_post( array(
		'post_type'   => 'repro_event',
		'post_status' => 'publish',
		'post_title'  => "Repro Event $i",
		'post_name'   => "repro-event-$i",
	) );
	if ( $pid && ! is_wp_error( $pid ) ) {
		wp_set_object_terms( $pid, array( $term_id ), 'repro_artist' );
	}
}

$blog_posts            = (int) wp_count_posts( 'post' )->publish;
$cpt_posts             = (int) wp_count_posts( 'repro_event' )->publish;
$ppp                   = (int) get_option( 'posts_per_page' );
$blog_main_query_pages = (int) ceil( $blog_posts / $ppp );

/* 4. Read how many pages each subtype advertises in the sitemap index. */
$sitemaps   = wp_sitemaps_get_server();
$index_list = $sitemaps->index->get_sitemap_list();
$cpt_sitemap_pages    = 0;
$artist_sitemap_pages = 0;
foreach ( $index_list as $entry ) {
	$loc = $entry['loc'] ?? '';
	if ( preg_match( '#wp-sitemap-posts-repro_event-(\d+)\.xml#', $loc, $m ) ) {
		$cpt_sitemap_pages = max( $cpt_sitemap_pages, (int) $m[1] );
	}
	if ( preg_match( '#wp-sitemap-taxonomies-repro_artist-(\d+)\.xml#', $loc, $m ) ) {
		$artist_sitemap_pages = max( $artist_sitemap_pages, (int) $m[1] );
	}
}

/* 5. Drive the REAL core request lifecycle for each sitemap sub-page URL.
 *    Mirrors WP::main(): query_posts() -> handle_404(). The status decision we
 *    care about happens in handle_404 BEFORE the renderer would run/exit. */
$probe = static function ( $query_vars_string ) {
	global $wp, $wp_query, $wp_the_query;

	$captured = array( 'status' => null );
	$cb = static function ( $header ) use ( &$captured ) {
		if ( preg_match( '#\s(\d{3})\s#', ' ' . $header . ' ', $m ) ) {
			$captured['status'] = (int) $m[1];
		}
		return $header;
	};
	add_filter( 'status_header', $cb, 10, 1 );

	$wp                  = new WP();
	$wp_query            = new WP_Query();
	$wp_the_query        = $wp_query;
	$GLOBALS['wp_query'] = $wp_query;

	parse_str( $query_vars_string, $qv );
	$wp->query_vars = $qv;
	$wp->query_posts();
	$wp->handle_404();

	$is_404 = $wp_query->is_404();

	// What WP_Sitemaps would actually render for this page (the body it 404s).
	$server    = wp_sitemaps_get_server();
	$sitemap   = $qv['sitemap'] ?? '';
	$subtype   = $qv['sitemap-subtype'] ?? '';
	$paged     = isset( $qv['paged'] ) ? (int) $qv['paged'] : 1;
	$url_count = null;
	if ( $sitemap && 'index' !== $sitemap ) {
		$provider = $server->registry->get_provider( $sitemap );
		if ( $provider ) {
			$url_list  = $provider->get_url_list( $paged ?: 1, $subtype );
			$url_count = is_array( $url_list ) ? count( $url_list ) : 0;
		}
	}

	remove_filter( 'status_header', $cb, 10 );

	return array(
		'query'                      => $query_vars_string,
		'paged'                      => $paged,
		'main_query_post_type'       => $wp_query->get( 'post_type' ),
		'main_query_posts'           => count( $wp_query->posts ),
		'main_query_found'           => (int) $wp_query->found_posts,
		'handle_404_set_is_404'      => $is_404,
		'status_header'              => $captured['status'],
		'sitemap_renderer_url_count' => $url_count,
		'result'                     => $is_404 ? '404 (core handle_404 flagged it)' : '200',
	);
};

$probes = array(
	// Within blog page count -> expected 200.
	'cpt_page_1'    => $probe( 'sitemap=posts&sitemap-subtype=repro_event&paged=1' ),
	// Beyond blog page count (3 > 2) -> the bug zone.
	'cpt_page_3'    => $probe( 'sitemap=posts&sitemap-subtype=repro_event&paged=3' ),
	'artist_page_1' => $probe( 'sitemap=taxonomies&sitemap-subtype=repro_artist&paged=1' ),
	'artist_page_3' => $probe( 'sitemap=taxonomies&sitemap-subtype=repro_artist&paged=3' ),
);

$bug_reproduced = ( true === $probes['cpt_page_3']['handle_404_set_is_404'] )
	&& ( $probes['cpt_page_3']['sitemap_renderer_url_count'] > 0 );

$result = array(
	'wp_version'              => get_bloginfo( 'version' ),
	'core_sitemaps_enabled'   => (bool) ( $sitemaps && $sitemaps->sitemaps_enabled() ),
	'no_404_prevention_hooks' => true,
	'config'                  => array(
		'blog_posts'            => $blog_posts,
		'cpt_posts'             => $cpt_posts,
		'posts_per_page'        => $ppp,
		'sitemap_max_urls'      => 50,
		'blog_main_query_pages' => $blog_main_query_pages,
		'cpt_sitemap_pages'     => $cpt_sitemap_pages,
		'artist_sitemap_pages'  => $artist_sitemap_pages,
	),
	'probes'                  => $probes,
	'bug_reproduced'          => $bug_reproduced,
	'verdict'                 => $bug_reproduced
		? 'CORE BUG: vanilla WP 7.0 404s a paginated sitemap page that has valid URLs, with no plugin involved.'
		: 'Not reproduced in this run.',
);

echo wp_json_encode( $result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
echo "\n";
