<?php
/**
 * WP_Codebox_Abilities_Browser_Blueprint implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Browser_Blueprint {
private static function browser_site_blueprint_artifact( array $input ): array|WP_Error {
	$artifact = is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array();
	if ( empty( $artifact ) ) {
		return array();
	}

	$blueprint = $artifact['blueprint'] ?? null;
	if ( ! is_array( $blueprint ) ) {
		return new WP_Error( 'wp_codebox_site_blueprint_artifact_invalid', 'site_blueprint_artifact.blueprint must be a Playground blueprint object.', array( 'status' => 400 ) );
	}

	return array(
		'schema'     => (string) ( $artifact['schema'] ?? 'wp-codebox/site-blueprint-artifact/v1' ),
		'id'         => (string) ( $artifact['id'] ?? '' ),
		'blueprint'  => $blueprint,
		'provenance' => is_array( $artifact['provenance'] ?? null ) ? $artifact['provenance'] : array(),
	);
}

/** @param array<string,mixed> $blueprint Blueprint override. @param array<string,mixed> $site_blueprint_artifact Normalized site blueprint artifact. @return array<string,mixed> */
private static function browser_blueprint_with_site_artifact( array $blueprint, array $site_blueprint_artifact ): array {
	$site_blueprint = is_array( $site_blueprint_artifact['blueprint'] ?? null ) ? $site_blueprint_artifact['blueprint'] : array();
	if ( empty( $site_blueprint ) ) {
		return $blueprint;
	}

	$site_steps = is_array( $site_blueprint['steps'] ?? null ) ? $site_blueprint['steps'] : array();
	$base_steps = is_array( $blueprint['steps'] ?? null ) ? $blueprint['steps'] : array();
	$merged     = array_merge( $site_blueprint, $blueprint );
	$merged['steps'] = array_values( array_merge( $site_steps, $base_steps ) );

	if ( isset( $site_blueprint['features'] ) && isset( $blueprint['features'] ) && is_array( $site_blueprint['features'] ) && is_array( $blueprint['features'] ) ) {
		$merged['features'] = array_merge( $site_blueprint['features'], $blueprint['features'] );
	}

	return $merged;
}

/** @param array<string,mixed> $blueprint Runtime-materialized blueprint. @param array<string,mixed> $post_runtime_blueprint Caller steps that must run after runtime dependencies. @return array<string,mixed> */
private static function browser_blueprint_with_post_runtime( array $blueprint, array $post_runtime_blueprint ): array {
	if ( empty( $post_runtime_blueprint ) ) {
		return $blueprint;
	}

	$steps      = is_array( $blueprint['steps'] ?? null ) ? $blueprint['steps'] : array();
	$post_steps = is_array( $post_runtime_blueprint['steps'] ?? null ) ? $post_runtime_blueprint['steps'] : array();
	$merged     = array_merge( $blueprint, $post_runtime_blueprint );
	$merged['steps'] = array_values( array_merge( $steps, $post_steps ) );

	if ( isset( $blueprint['features'] ) && isset( $post_runtime_blueprint['features'] ) && is_array( $blueprint['features'] ) && is_array( $post_runtime_blueprint['features'] ) ) {
		$merged['features'] = array_merge( $blueprint['features'], $post_runtime_blueprint['features'] );
	}

	return $merged;
}

/** @param array<string,mixed> $blueprint Blueprint override. @param array<string,mixed> $runtime Runtime dependency specs. @return array<string,mixed> */
private static function browser_blueprint_with_runtime( array $blueprint, array $runtime, array $playground = array() ): array {
	$steps = is_array( $blueprint['steps'] ?? null ) ? $blueprint['steps'] : array();
	if ( ! self::browser_blueprint_has_login_step( $steps ) ) {
		array_unshift(
			$steps,
			array(
				'step'     => 'login',
				'username' => 'admin',
				'password' => 'password',
			)
		);
	}

	foreach ( $runtime['plugins'] as $plugin ) {
		if ( ! empty( $plugin['local_package'] ) ) {
			$write_step = self::browser_local_package_write_step( $plugin, 'plugin' );
			if ( ! empty( $write_step ) ) {
				$steps[] = $write_step;
			}
			$steps[] = array(
				'step' => 'runPHP',
				'code' => self::browser_plugin_install_php( $plugin, (string) ( $write_step['path'] ?? '' ) ),
			);
			continue;
		}

		$plugin_data = array(
			'resource' => (string) ( $plugin['resource'] ?? 'url' ),
			'url'      => $plugin['url'],
		);

		if ( 'git:directory' === $plugin_data['resource'] ) {
			$plugin_data['ref']     = (string) ( $plugin['ref'] ?? 'main' );
			$plugin_data['refType'] = (string) ( $plugin['refType'] ?? 'branch' );
			if ( '' !== (string) ( $plugin['path'] ?? '' ) ) {
				$plugin_data['path'] = (string) $plugin['path'];
			}
		}

		$options = array(
			'activate' => (bool) $plugin['activate'],
		);
		if ( '' !== (string) ( $plugin['targetFolderName'] ?? '' ) ) {
			$options['targetFolderName'] = (string) $plugin['targetFolderName'];
		}

		$steps[] = array(
			'step'       => 'installPlugin',
			'pluginData' => $plugin_data,
			'options'    => $options,
		);
	}

	foreach ( $runtime['mu_plugins'] as $mu_plugin ) {
		$write_step = ! empty( $mu_plugin['local_package'] ) ? self::browser_local_package_write_step( $mu_plugin, 'mu-plugin' ) : array();
		if ( ! empty( $write_step ) ) {
			$steps[] = $write_step;
		}
		$steps[] = array(
			'step' => 'runPHP',
			'code' => self::browser_mu_plugin_install_php( $mu_plugin, (string) ( $write_step['path'] ?? '' ) ),
		);
	}

	foreach ( $runtime['themes'] as $theme ) {
		if ( ! empty( $theme['url'] ) ) {
			if ( ! empty( $theme['local_package'] ) ) {
				$write_step = self::browser_local_package_write_step( $theme, 'theme' );
				if ( ! empty( $write_step ) ) {
					$steps[] = $write_step;
				}
				$steps[] = array(
					'step' => 'runPHP',
					'code' => self::browser_theme_package_install_php( $theme, (string) ( $write_step['path'] ?? '' ) ),
				);
			} else {
				$steps[] = array(
					'step'      => 'installTheme',
					'themeData' => array(
						'resource' => 'url',
						'url'      => $theme['url'],
					),
					'options'   => array(
						'activate' => (bool) $theme['activate'],
					),
				);
			}
		}

		if ( ! empty( $theme['files'] ) ) {
			$steps[] = array(
				'step' => 'runPHP',
				'code' => self::browser_theme_files_install_php( $theme ),
			);
		}
	}

	foreach ( $runtime['bootstrap'] as $operation ) {
		$steps[] = array(
			'step' => 'runPHP',
			'code' => self::browser_bootstrap_operation_php( $operation ),
		);
	}

	$blueprint['steps'] = $steps;
	if ( ! isset( $blueprint['preferredVersions'] ) ) {
		$blueprint['preferredVersions'] = array(
			'wp'  => (string) ( $playground['wp'] ?? 'latest' ),
			'php' => (string) ( $playground['php'] ?? 'latest' ),
		);
	}
	if ( ! isset( $blueprint['features'] ) ) {
		$blueprint['features'] = array( 'networking' => true );
	}

	return $blueprint;
}

/** @param array<string,mixed> $package Runtime package spec. @return array<string,mixed> */
private static function browser_local_package_write_step( array $package, string $kind ): array {
	$url = (string) ( $package['local_package_fetch_url'] ?? $package['url'] ?? '' );
	if ( '' === $url || str_starts_with( $url, 'data:application/zip;base64,' ) ) {
		return array();
	}

	$digest = (string) ( $package['sha256'] ?? '' );
	if ( '' === $digest ) {
		$digest = hash( 'sha256', $kind . ':' . $url );
	}

	return array(
		'step' => 'writeFile',
		'path' => '/tmp/wp-codebox-' . sanitize_key( $kind ) . '-' . substr( $digest, 0, 16 ) . '.zip',
		'data' => array(
			'resource' => 'url',
			'url'      => $url,
		),
	);
}

/** @param array<string,mixed> $prepared Prepared runtime descriptor. @param array<string,mixed> $fallback_blueprint Full dynamic blueprint. @param array<string,mixed> $playground Playground settings. @return array<string,mixed> */
private static function browser_prepared_runtime_with_blueprints( array $prepared, array $fallback_blueprint, array $playground = array() ): array {
	if ( 'wp-codebox/browser-prepared-runtime/v1' !== ( $prepared['schema'] ?? '' ) || 'disabled' === ( $prepared['status'] ?? '' ) ) {
		return $prepared;
	}

	$started_at          = microtime( true );
	$prepared_blueprint = is_array( $prepared['blueprint'] ?? null ) ? $prepared['blueprint'] : array();
	$cache_lookup       = self::browser_prepared_runtime_cache_lookup( $prepared );
	if ( empty( $prepared_blueprint ) && is_array( $cache_lookup['artifact'] ?? null ) ) {
		$artifact           = $cache_lookup['artifact'];
		$prepared_blueprint = is_array( $artifact['blueprint'] ?? null ) ? $artifact['blueprint'] : array();
		if ( ! empty( $prepared_blueprint ) ) {
			$prepared['status']          = 'hit';
			$prepared['provided_hash']   = (string) ( $artifact['input_hash'] ?? $prepared['input_hash'] ?? '' );
			$prepared['snapshot']        = $artifact;
			$prepared['invalidation']    = array( 'reason' => 'cache-hit' );
			$prepared['prepared_source'] = 'transient-cache';
		}
	}

	if ( ! empty( $prepared_blueprint ) ) {
		$prepared_blueprint = self::browser_playground_blueprint( $prepared_blueprint, $playground );
	}
	$prepared['diagnostics'] = self::browser_prepared_runtime_diagnostics( $prepared, $cache_lookup, $started_at );
	if ( empty( $prepared_blueprint ) && 'miss' === ( $prepared['status'] ?? '' ) ) {
		$prepared['diagnostics']['prepared_snapshot_stored'] = self::browser_prepared_runtime_cache_store( $prepared, $fallback_blueprint );
	}

	return array_filter(
		array_merge(
			$prepared,
			array(
				'blueprint'          => $prepared_blueprint,
				'fallback_blueprint' => self::browser_playground_blueprint( $fallback_blueprint, $playground ),
				'selected'           => 'hit' === ( $prepared['status'] ?? '' ) && ! empty( $prepared_blueprint ) ? 'prepared' : 'fallback',
			)
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @return array{status:string,artifact?:array<string,mixed>,key?:string,invalidation?:array<string,string>} */
private static function browser_prepared_runtime_cache_lookup( array $prepared ): array {
	$transient_key = self::browser_prepared_runtime_transient_key( $prepared );
	if ( '' === $transient_key ) {
		return array( 'status' => 'hydratable_ref_missing', 'invalidation' => array( 'reason' => 'hydratable-ref-missing' ) );
	}

	$artifact = function_exists( 'get_transient' ) ? get_transient( $transient_key ) : false;
	if ( ! is_array( $artifact ) ) {
		return array( 'status' => 'expired_transient', 'key' => $transient_key, 'invalidation' => array( 'reason' => 'expired-transient' ) );
	}

	$input_hash = (string) ( $prepared['input_hash'] ?? '' );
	if ( $input_hash !== (string) ( $artifact['input_hash'] ?? '' ) ) {
		return array( 'status' => 'input_hash_mismatch', 'key' => $transient_key, 'artifact' => $artifact, 'invalidation' => array( 'reason' => 'input-hash-mismatch' ) );
	}
	if ( 'wp-codebox/browser-prepared-runtime-artifact/v1' !== ( $artifact['schema'] ?? '' ) || ! is_array( $artifact['blueprint'] ?? null ) ) {
		return array( 'status' => 'cache_miss', 'key' => $transient_key, 'artifact' => $artifact, 'invalidation' => array( 'reason' => 'cache-miss' ) );
	}

	return array( 'status' => 'hit', 'key' => $transient_key, 'artifact' => $artifact );
}

private static function browser_prepared_runtime_cache_store( array $prepared, array $fallback_blueprint ): bool {
	$transient_key = self::browser_prepared_runtime_transient_key( $prepared );
	if ( '' === $transient_key || empty( $fallback_blueprint ) || ! function_exists( 'set_transient' ) ) {
		return false;
	}

	$input_hash = (string) ( $prepared['input_hash'] ?? '' );
	$artifact   = array(
		'schema'        => 'wp-codebox/browser-prepared-runtime-artifact/v1',
		'cache_key'     => (string) ( $prepared['cache_key'] ?? '' ),
		'input_hash'    => $input_hash,
		'source_digest' => array( 'algorithm' => 'sha256', 'value' => $input_hash ),
		'created_at'    => gmdate( 'c' ),
		'strategy'      => (string) ( $prepared['strategy'] ?? 'prepared-blueprint' ),
		'blueprint'     => $fallback_blueprint,
	);
	$ttl        = (int) apply_filters( 'wp_codebox_browser_prepared_runtime_cache_ttl', defined( 'WEEK_IN_SECONDS' ) ? WEEK_IN_SECONDS : 604800, $prepared, $artifact );
	return set_transient( $transient_key, $artifact, max( 1, $ttl ) );
}

private static function browser_prepared_runtime_transient_key( array $prepared ): string {
	if ( false === ( $prepared['cache'] ?? true ) ) {
		return '';
	}

	$cache_key  = self::safe_key( (string) ( $prepared['cache_key'] ?? '' ) );
	$input_hash = strtolower( (string) ( $prepared['input_hash'] ?? '' ) );
	if ( '' === $cache_key || ! preg_match( '/^[a-f0-9]{64}$/', $input_hash ) ) {
		return '';
	}

	return 'wp_codebox_browser_prepared_runtime_' . substr( hash( 'sha256', $cache_key . ':' . $input_hash ), 0, 24 );
}

/** @param array<string,mixed> $cache_lookup */
private static function browser_prepared_runtime_diagnostics( array $prepared, array $cache_lookup, float $started_at ): array {
	$cache_key  = (string) ( $prepared['cache_key'] ?? '' );
	$input_hash = (string) ( $prepared['input_hash'] ?? '' );
	return array_filter(
		array(
			'schema'                 => 'wp-codebox/browser-prepared-runtime-diagnostics/v1',
			'contract_compile_ms'    => 0,
			'blueprint_compile_ms'   => (int) round( ( microtime( true ) - $started_at ) * 1000 ),
			'runtime_package_resolution_ms' => 0,
			'prepared_snapshot_hit'  => 'hit' === ( $prepared['status'] ?? '' ),
			'prepared_snapshot_miss' => 'hit' !== ( $prepared['status'] ?? '' ),
			'prepared_snapshot_key'  => $cache_key,
			'source_digest'          => '' !== $input_hash ? array( 'algorithm' => 'sha256', 'value' => $input_hash ) : array(),
			'cache_status'           => (string) ( $cache_lookup['status'] ?? 'disabled' ),
			'cache_transient_key'    => (string) ( $cache_lookup['key'] ?? '' ),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

/** @param array<string,mixed> $prepared Prepared runtime descriptor. @param array<string,mixed> $fallback_blueprint Full dynamic blueprint. @return array<string,mixed> */
private static function browser_selected_prepared_runtime_blueprint( array $prepared, array $fallback_blueprint ): array {
	if ( 'prepared' === ( $prepared['selected'] ?? '' ) && is_array( $prepared['blueprint'] ?? null ) && ! empty( $prepared['blueprint'] ) ) {
		return $prepared['blueprint'];
	}

	return $fallback_blueprint;
}

/** @param array<string,mixed> $plugin Plugin spec. */
private static function browser_plugin_install_php( array $plugin, string $package_path = '' ): string {
	$target_folder = sanitize_key( (string) ( $plugin['targetFolderName'] ?? $plugin['slug'] ?? '' ) );
	if ( '' === $target_folder ) {
		$target_folder = 'wp-codebox-runtime-plugin';
	}

	$package_url = (string) ( $plugin['url'] ?? '' );

	return '<?php
$package_url = ' . var_export( $package_url, true ) . ';
$package_path = ' . var_export( $package_path, true ) . ';
$expected_sha256 = ' . var_export( (string) ( $plugin['sha256'] ?? '' ), true ) . ';
$target_folder = ' . var_export( $target_folder, true ) . ';
$activate = ' . ( ! empty( $plugin['activate'] ) ? 'true' : 'false' ) . ';

$archive = "" !== $package_path
? file_get_contents( $package_path )
: ( str_starts_with( $package_url, "data:application/zip;base64," )
? base64_decode( substr( $package_url, strlen( "data:application/zip;base64," ) ), true )
: file_get_contents( $package_url ) );
if ( ! is_string( $archive ) || "" === $archive ) {
throw new RuntimeException( "Could not read browser plugin package." );
}
if ( "" !== $expected_sha256 && ! hash_equals( $expected_sha256, hash( "sha256", $archive ) ) ) {
throw new RuntimeException( "Browser plugin package hash mismatch." );
}

$tmp_zip = tempnam( sys_get_temp_dir(), "wp-codebox-plugin-" );
if ( false === $tmp_zip || false === file_put_contents( $tmp_zip, $archive ) ) {
throw new RuntimeException( "Could not stage browser plugin package." );
}

$zip = new ZipArchive();
if ( true !== $zip->open( $tmp_zip ) ) {
@unlink( $tmp_zip );
throw new RuntimeException( "Could not open browser plugin package." );
}

$plugins_directory = "/wordpress/wp-content/plugins";
if ( ! is_dir( $plugins_directory ) ) {
mkdir( $plugins_directory, 0777, true );
}
$zip->extractTo( $plugins_directory );
$zip->close();
@unlink( $tmp_zip );

if ( $activate ) {
require_once "/wordpress/wp-load.php";
require_once ABSPATH . "wp-admin/includes/plugin.php";
$plugins = get_plugins( "/" . $target_folder );
$plugin_file = "";
foreach ( array_keys( $plugins ) as $file ) {
	$plugin_file = $target_folder . "/" . $file;
	break;
}
if ( "" === $plugin_file ) {
	throw new RuntimeException( "Browser plugin package entry file is missing." );
}
$result = activate_plugin( $plugin_file );
if ( is_wp_error( $result ) ) {
	throw new RuntimeException( $result->get_error_message() );
}
}
';
}

/** @param array<string,mixed> $mu_plugin Mu-plugin spec. */
private static function browser_mu_plugin_install_php( array $mu_plugin, string $package_path = '' ): string {
	if ( ! empty( $mu_plugin['local_package'] ) ) {
		return self::browser_packaged_mu_plugin_install_php( $mu_plugin, $package_path );
	}

	return '<?php
$path = ' . var_export( $mu_plugin['path'], true ) . ';
$directory = dirname( $path );
if ( ! is_dir( $directory ) ) {
mkdir( $directory, 0777, true );
}
file_put_contents( $path, ' . var_export( $mu_plugin['content'], true ) . ' );
';
}

/** @param array<string,mixed> $mu_plugin Packaged mu-plugin spec. */
private static function browser_packaged_mu_plugin_install_php( array $mu_plugin, string $package_path = '' ): string {
	$package_url = (string) ( $mu_plugin['url'] ?? '' );

	return '<?php
$package_url = ' . var_export( $package_url, true ) . ';
$package_path = ' . var_export( $package_path, true ) . ';
$expected_sha256 = ' . var_export( (string) ( $mu_plugin['sha256'] ?? '' ), true ) . ';
$target_directory = "/wordpress/wp-content/mu-plugins/" . ' . var_export( (string) $mu_plugin['targetFolderName'], true ) . ';
$loader_path = ' . var_export( (string) $mu_plugin['path'], true ) . ';
$entry = ' . var_export( (string) $mu_plugin['entry'], true ) . ';

$archive = "" !== $package_path
? file_get_contents( $package_path )
: ( str_starts_with( $package_url, "data:application/zip;base64," )
? base64_decode( substr( $package_url, strlen( "data:application/zip;base64," ) ), true )
: file_get_contents( $package_url ) );
if ( ! is_string( $archive ) || "" === $archive ) {
throw new RuntimeException( "Could not read browser mu-plugin package." );
}
if ( "" !== $expected_sha256 && ! hash_equals( $expected_sha256, hash( "sha256", $archive ) ) ) {
throw new RuntimeException( "Browser mu-plugin package hash mismatch." );
}

$tmp_zip = tempnam( sys_get_temp_dir(), "wp-codebox-mu-plugin-" );
if ( false === $tmp_zip || false === file_put_contents( $tmp_zip, $archive ) ) {
throw new RuntimeException( "Could not stage browser mu-plugin package." );
}

$zip = new ZipArchive();
if ( true !== $zip->open( $tmp_zip ) ) {
@unlink( $tmp_zip );
throw new RuntimeException( "Could not open browser mu-plugin package." );
}
if ( ! is_dir( $target_directory ) ) {
mkdir( $target_directory, 0777, true );
}
$zip->extractTo( dirname( $target_directory ) );
$zip->close();
@unlink( $tmp_zip );

$entry_path = $target_directory . "/" . $entry;
if ( ! is_readable( $entry_path ) ) {
throw new RuntimeException( "Browser mu-plugin package entry file is missing." );
}
$loader_directory = dirname( $loader_path );
if ( ! is_dir( $loader_directory ) ) {
mkdir( $loader_directory, 0777, true );
}
file_put_contents( $loader_path, "<?php\nrequire_once " . var_export( $entry_path, true ) . ";\n" );
';
}

/** @param array<string,mixed> $theme Theme package spec. */
private static function browser_theme_package_install_php( array $theme, string $package_path = '' ): string {
	$package_url = (string) ( $theme['url'] ?? '' );
	$slug        = (string) ( $theme['slug'] ?? '' );

	return '<?php
$package_url = ' . var_export( $package_url, true ) . ';
$package_path = ' . var_export( $package_path, true ) . ';
$expected_sha256 = ' . var_export( (string) ( $theme['sha256'] ?? '' ), true ) . ';
$slug = ' . var_export( $slug, true ) . ';
$activate = ' . ( ! empty( $theme['activate'] ) ? 'true' : 'false' ) . ';

$archive = "" !== $package_path
? file_get_contents( $package_path )
: ( str_starts_with( $package_url, "data:application/zip;base64," )
? base64_decode( substr( $package_url, strlen( "data:application/zip;base64," ) ), true )
: file_get_contents( $package_url ) );
if ( ! is_string( $archive ) || "" === $archive ) {
throw new RuntimeException( "Could not read browser theme package." );
}
if ( "" !== $expected_sha256 && ! hash_equals( $expected_sha256, hash( "sha256", $archive ) ) ) {
throw new RuntimeException( "Browser theme package hash mismatch." );
}

$tmp_zip = tempnam( sys_get_temp_dir(), "wp-codebox-theme-" );
if ( false === $tmp_zip || false === file_put_contents( $tmp_zip, $archive ) ) {
throw new RuntimeException( "Could not stage browser theme package." );
}

$zip = new ZipArchive();
if ( true !== $zip->open( $tmp_zip ) ) {
@unlink( $tmp_zip );
throw new RuntimeException( "Could not open browser theme package." );
}

$themes_directory = "/wordpress/wp-content/themes";
if ( ! is_dir( $themes_directory ) ) {
mkdir( $themes_directory, 0777, true );
}
$zip->extractTo( $themes_directory );
$zip->close();
@unlink( $tmp_zip );

if ( $activate ) {
' . self::browser_theme_activation_php( $slug ) . '
}
';
}

/** @param array<string,mixed> $theme Theme spec. */
private static function browser_theme_files_install_php( array $theme ): string {
	$files = array();
	foreach ( $theme['files'] as $file ) {
		$files[ $file['playground_path'] ] = $file['content'];
	}

	return '<?php
$files = ' . var_export( $files, true ) . ';
foreach ( $files as $path => $content ) {
$directory = dirname( $path );
if ( ! is_dir( $directory ) ) {
	mkdir( $directory, 0777, true );
}
file_put_contents( $path, $content );
}
' . ( (bool) $theme['activate'] ? self::browser_theme_activation_php( (string) $theme['slug'] ) : '' ) . '
';
}

private static function browser_theme_activation_php( string $slug ): string {
	return self::browser_wordpress_bootstrap_php() . '
if ( ! function_exists( \'switch_theme\' ) ) {
require_once ABSPATH . WPINC . \'/theme.php\';
}
switch_theme( ' . var_export( $slug, true ) . ' );';
}

private static function browser_wordpress_bootstrap_php(): string {
	return 'if ( ! defined( \'ABSPATH\' ) ) {
require_once \'/wordpress/wp-load.php\';
}';
}

/** @param array<string,mixed> $operation Bootstrap operation spec. */
private static function browser_bootstrap_operation_php( array $operation ): string {
	$args = is_array( $operation['args'] ?? null ) ? $operation['args'] : array();
	switch ( $operation['operation'] ) {
		case 'set_option':
			return '<?php
' . self::browser_wordpress_bootstrap_php() . '
update_option( ' . var_export( (string) ( $args['name'] ?? $args['option'] ?? '' ), true ) . ', ' . var_export( $args['value'] ?? '', true ) . ' );
';
		case 'activate_plugin':
			return '<?php
' . self::browser_wordpress_bootstrap_php() . '
activate_plugin( ' . var_export( (string) ( $args['plugin'] ?? '' ), true ) . ' );
';
		case 'activate_theme':
			return '<?php
' . self::browser_theme_activation_php( (string) ( $args['slug'] ?? $args['theme'] ?? '' ) ) . '
';
		case 'flush_rewrite_rules':
			return '<?php
' . self::browser_wordpress_bootstrap_php() . '
flush_rewrite_rules();
';
	}

	return '<?php';
}

/** @param array<string,mixed> $runtime Runtime dependency specs. @return array<string,mixed> */
private static function browser_runtime_readiness_metadata( array $runtime ): array {
	return array(
		'schema'    => 'wp-codebox/browser-runtime-readiness/v1',
		'compiled'  => true,
		'summary'   => $runtime['summary'] ?? array(),
		'plugins'   => array_map( static fn( array $plugin ): array => array( 'slug' => $plugin['slug'] ?? '', 'activate' => (bool) ( $plugin['activate'] ?? true ), 'readiness' => 'compiled' ), $runtime['plugins'] ?? array() ),
		'mu_plugins' => array_map( static fn( array $mu_plugin ): array => array( 'slug' => $mu_plugin['slug'] ?? '', 'file' => $mu_plugin['file'] ?? '', 'readiness' => $mu_plugin['readiness'] ?? 'compiled' ), $runtime['mu_plugins'] ?? array() ),
		'themes'    => array_map( static fn( array $theme ): array => array( 'slug' => $theme['slug'] ?? '', 'activate' => (bool) ( $theme['activate'] ?? true ), 'readiness' => $theme['readiness'] ?? 'compiled' ), $runtime['themes'] ?? array() ),
		'bootstrap' => array_map( static fn( array $operation ): array => array( 'operation' => $operation['operation'] ?? '', 'readiness' => $operation['readiness'] ?? 'compiled' ), $runtime['bootstrap'] ?? array() ),
	);
}

/** @param array<int,mixed> $steps Blueprint steps. */
private static function browser_blueprint_has_login_step( array $steps ): bool {
	foreach ( $steps as $step ) {
		if ( is_array( $step ) && 'login' === (string) ( $step['step'] ?? '' ) ) {
			return true;
		}
	}

	return false;
}

}
