<?php
/**
 * Theme block-editor cookbook seed.
 *
 * Run after the recipe has mounted a theme under test at
 * /wordpress/wp-content/themes/theme-under-test.
 *
 * Activates the mounted theme, creates a block-rich page plus a few posts for
 * query-loop coverage, sets the page as the front page, and emits JSON with
 * frontend, editor, and admin URLs for preview review.
 */

$theme_slug = 'theme-under-test';
$theme      = wp_get_theme( $theme_slug );

if ( ! $theme->exists() ) {
	throw new RuntimeException( 'Mounted theme not found at wp-content/themes/' . $theme_slug );
}

switch_theme( $theme_slug );

$sample_post_ids = array();
for ( $i = 1; $i <= 3; $i++ ) {
	$post_id = wp_insert_post( array(
		'post_title'   => sprintf( 'Cookbook update %d', $i ),
		'post_content' => sprintf(
			'<!-- wp:paragraph --><p>Sample post %d exists so Query Loop and archive styles have real content.</p><!-- /wp:paragraph -->',
			$i
		),
		'post_status'  => 'publish',
		'post_type'    => 'post',
		'post_author'  => 1,
	) );

	if ( is_wp_error( $post_id ) || ! $post_id ) {
		throw new RuntimeException( 'Failed to create sample post ' . $i );
	}

	$sample_post_ids[] = (int) $post_id;
}

$page_content = <<<'HTML'
<!-- wp:cover {"dimRatio":45,"overlayColor":"contrast","minHeight":360,"align":"full","style":{"spacing":{"padding":{"top":"6rem","bottom":"6rem","left":"2rem","right":"2rem"}}}} -->
<div class="wp-block-cover alignfull" style="padding-top:6rem;padding-right:2rem;padding-bottom:6rem;padding-left:2rem;min-height:360px"><span aria-hidden="true" class="wp-block-cover__background has-contrast-background-color has-background-dim-45 has-background-dim"></span><div class="wp-block-cover__inner-container"><!-- wp:heading {"textAlign":"center","level":1,"fontSize":"xx-large"} -->
<h1 class="wp-block-heading has-text-align-center has-xx-large-font-size">Theme block editor smoke page</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","fontSize":"large"} -->
<p class="has-text-align-center has-large-font-size">A seeded layout for checking theme styles in the frontend and block editor.</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons"><!-- wp:button -->
<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="#editor-surfaces">Review block surfaces</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div></div>
<!-- /wp:cover -->

<!-- wp:group {"tagName":"main","layout":{"type":"constrained"},"style":{"spacing":{"padding":{"top":"3rem","bottom":"3rem"}}}} -->
<main id="editor-surfaces" class="wp-block-group" style="padding-top:3rem;padding-bottom:3rem"><!-- wp:columns {"align":"wide"} -->
<div class="wp-block-columns alignwide"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Typography and spacing</h2>
<!-- /wp:heading -->

<!-- wp:paragraph -->
<p>This column exercises heading, paragraph, link, and column spacing rules in both rendered and editor contexts.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>A realistic smoke page should expose the theme's block-level defaults quickly.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<!-- wp:separator {"align":"wide"} -->
<hr class="wp-block-separator alignwide has-alpha-channel-opacity"/>
<!-- /wp:separator -->

<!-- wp:query {"query":{"perPage":3,"pages":0,"offset":0,"postType":"post","order":"desc","orderBy":"date","author":"","search":"","exclude":[],"sticky":"","inherit":false},"align":"wide"} -->
<div class="wp-block-query alignwide"><!-- wp:post-template {"layout":{"type":"grid","columnCount":3}} -->
<!-- wp:post-title {"isLink":true} /-->
<!-- wp:post-excerpt {"moreText":"Read more"} /-->
<!-- /wp:post-template --></div>
<!-- /wp:query --></main>
<!-- /wp:group -->
HTML;

$page_id = wp_insert_post( array(
	'post_title'   => 'Theme Block Editor Cookbook',
	'post_content' => $page_content,
	'post_status'  => 'publish',
	'post_type'    => 'page',
	'post_author'  => 1,
) );

if ( is_wp_error( $page_id ) || ! $page_id ) {
	throw new RuntimeException( 'Failed to create block editor smoke page' );
}

update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', (int) $page_id );
update_option( 'permalink_structure', '/%postname%/' );

global $wp_rewrite;
$wp_rewrite->init();
$wp_rewrite->flush_rules( false );

wp_set_auth_cookie( 1, true );

echo wp_json_encode( array(
	'theme'              => $theme_slug,
	'theme_active'       => get_stylesheet() === $theme_slug,
	'page_id'            => (int) $page_id,
	'sample_post_ids'    => $sample_post_ids,
	'frontend_url'       => get_permalink( $page_id ),
	'front_page_url'     => home_url( '/' ),
	'block_editor_url'   => admin_url( 'post.php?post=' . (int) $page_id . '&action=edit' ),
	'pages_admin_url'    => admin_url( 'edit.php?post_type=page' ),
	'dashboard_url'      => admin_url( 'index.php' ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
echo "\n";
