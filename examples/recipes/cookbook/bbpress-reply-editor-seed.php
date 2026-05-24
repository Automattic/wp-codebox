<?php
/**
 * bbPress reply-editor cookbook seed.
 *
 * Run after the recipe's blueprint has installed bbPress and the recipe has
 * mounted a plugin under test at /wordpress/wp-content/plugins/plugin-under-test.
 *
 * Creates one forum + one topic so the bbPress reply editor renders against
 * real data. Auto-logs in as admin so the reply form is shown (not the
 * "you must be logged in" screen).
 *
 * Output: JSON describing the seeded forum + topic + the reply-form URL the
 * sandbox preview should navigate to.
 */

require_once ABSPATH . 'wp-admin/includes/plugin.php';

// Activate the plugin under test if the recipe mounted one and it isn't
// already active via blueprint.
$plugin_under_test = 'plugin-under-test/plugin-under-test.php';
if ( file_exists( WP_PLUGIN_DIR . '/' . $plugin_under_test ) && ! is_plugin_active( $plugin_under_test ) ) {
	activate_plugin( $plugin_under_test );
}

// Force bbPress to register its post types so wp_insert_post knows about them.
if ( function_exists( 'bbpress' ) ) {
	bbpress()->register_post_types();
	bbpress()->register_post_statuses();
	bbpress()->register_taxonomies();
}

$forum_id = wp_insert_post( array(
	'post_title'   => 'Cookbook Test Forum',
	'post_content' => 'A forum for exercising the bbPress reply editor.',
	'post_status'  => 'publish',
	'post_type'    => 'forum',
	'post_author'  => 1,
) );

if ( is_wp_error( $forum_id ) || ! $forum_id ) {
	throw new RuntimeException( 'Failed to create forum' );
}

$topic_id = wp_insert_post( array(
	'post_title'   => 'Cookbook smoke topic — reply below to exercise the editor',
	'post_content' => '<p>This topic exists so the bbPress reply form below renders against real data. Scroll to the bottom and click into the reply editor to exercise whatever plugin under test you mounted.</p>',
	'post_status'  => 'publish',
	'post_type'    => 'topic',
	'post_parent'  => $forum_id,
	'post_author'  => 1,
) );

if ( is_wp_error( $topic_id ) || ! $topic_id ) {
	throw new RuntimeException( 'Failed to create topic' );
}

update_post_meta( $topic_id, '_bbp_forum_id', $forum_id );
update_post_meta( $topic_id, '_bbp_topic_id', $topic_id );

// Set pretty permalinks so /forums/topic/<slug>/ resolves correctly.
update_option( 'permalink_structure', '/%postname%/' );

global $wp_rewrite;
$wp_rewrite->init();
$wp_rewrite->flush_rules( false );

// Auto-login admin (the blueprint also does this but belt-and-suspenders helps
// if a caller swaps the blueprint and drops the login step).
wp_set_auth_cookie( 1, true );

echo wp_json_encode( array(
	'forum_id'           => (int) $forum_id,
	'topic_id'           => (int) $topic_id,
	'topic_permalink'    => get_permalink( $topic_id ),
	'reply_form_anchor'  => get_permalink( $topic_id ) . '#new-post',
	'home_url'           => home_url( '/' ),
	'bbpress_active'     => is_plugin_active( 'bbpress/bbpress.php' ),
	'plugin_under_test'  => is_plugin_active( $plugin_under_test ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
echo "\n";
