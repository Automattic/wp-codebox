<?php
/**
 * Multisite network cookbook seed.
 *
 * Run after WP-CLI has converted the Playground install to multisite and the
 * recipe has mounted a plugin under test at /wordpress/wp-content/plugins/plugin-under-test.
 *
 * Creates two child sites and emits URLs for network and per-site review.
 */

require_once ABSPATH . 'wp-admin/includes/plugin.php';

if ( ! is_multisite() ) {
	throw new RuntimeException( 'Expected multisite mode after wp core multisite-convert.' );
}

$plugin_under_test = null;
foreach ( get_plugins( '/plugin-under-test' ) as $plugin_file => $plugin_data ) {
	if ( ! empty( $plugin_data['Name'] ) ) {
		$plugin_under_test = 'plugin-under-test/' . $plugin_file;
		break;
	}
}

if ( $plugin_under_test && ! is_plugin_active_for_network( $plugin_under_test ) ) {
	$activation_result = activate_plugin( $plugin_under_test, '', true );
	if ( is_wp_error( $activation_result ) ) {
		throw new RuntimeException( $activation_result->get_error_message() );
	}
}

$network_host = wp_parse_url( network_home_url( '/' ), PHP_URL_HOST ) ?: 'example.org';
$seeded_sites = array();

foreach ( array(
	'alpha' => 'Cookbook Alpha Site',
	'beta'  => 'Cookbook Beta Site',
) as $slug => $title ) {
	$path     = '/' . $slug . '/';
	$existing = get_sites( array(
		'domain' => $network_host,
		'path'   => $path,
		'number' => 1,
	) );

	$site_id = $existing ? (int) $existing[0]->blog_id : wpmu_create_blog( $network_host, $path, $title, 1 );
	if ( is_wp_error( $site_id ) || ! $site_id ) {
		$message = is_wp_error( $site_id ) ? $site_id->get_error_message() : sprintf( 'Failed to create site %s', $path );
		throw new RuntimeException( $message );
	}

	switch_to_blog( (int) $site_id );
	$page_id = wp_insert_post( array(
		'post_title'   => sprintf( '%s smoke page', $title ),
		'post_content' => sprintf( '<p>This page was seeded on %s for the WP Codebox multisite cookbook.</p>', esc_html( $title ) ),
		'post_status'  => 'publish',
		'post_type'    => 'page',
		'post_author'  => 1,
	) );
	restore_current_blog();

	if ( is_wp_error( $page_id ) || ! $page_id ) {
		throw new RuntimeException( sprintf( 'Failed to create smoke page for site %s', $path ) );
	}

	$site_path = ltrim( $path, '/' );

	$seeded_sites[] = array(
		'id'        => (int) $site_id,
		'slug'      => $slug,
		'title'     => $title,
		'url'       => network_home_url( $site_path ),
		'admin_url' => network_home_url( $site_path . 'wp-admin/' ),
		'page_id'   => (int) $page_id,
		'page_url'  => network_home_url( $site_path . '?page_id=' . (int) $page_id ),
	);
}

echo wp_json_encode( array(
	'is_multisite'                => is_multisite(),
	'network_id'                  => get_current_network_id(),
	'main_site_id'                => get_main_site_id(),
	'network_home_url'            => network_home_url( '/' ),
	'network_admin_url'           => network_admin_url( '/' ),
	'main_site_url'               => get_site_url( get_main_site_id(), '/' ),
	'main_site_admin_url'         => get_admin_url( get_main_site_id(), '/' ),
	'sites'                       => $seeded_sites,
	'plugin_under_test'           => (bool) $plugin_under_test,
	'plugin_file'                 => $plugin_under_test,
	'plugin_network_active'       => $plugin_under_test ? is_plugin_active_for_network( $plugin_under_test ) : false,
	'network_admin_plugins_url'   => network_admin_url( 'plugins.php' ),
	'network_admin_sites_url'     => network_admin_url( 'sites.php' ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
echo "\n";
