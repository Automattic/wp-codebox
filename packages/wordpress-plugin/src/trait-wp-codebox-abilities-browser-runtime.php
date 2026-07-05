<?php
/**
 * WP_Codebox_Abilities_Browser_Runtime implementation.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Abilities_Browser_Runtime {
/** @param array<int,mixed> $mu_plugins Mu-plugin dependency specs. @return array<int,array<string,mixed>>|WP_Error */
private static function normalize_browser_mu_plugins( array $mu_plugins ): array|WP_Error {
	$normalized = array();
	foreach ( $mu_plugins as $index => $mu_plugin ) {
		if ( ! is_array( $mu_plugin ) ) {
			return new WP_Error( 'wp_codebox_browser_mu_plugin_invalid', 'Each browser mu-plugin must be an object.', array( 'status' => 400, 'index' => $index ) );
		}

		$slug = self::safe_key( (string) ( $mu_plugin['slug'] ?? '' ) );
		$file = trim( (string) ( $mu_plugin['file'] ?? ( '' !== $slug ? $slug . '.php' : '' ) ) );
		if ( '' === $file || str_contains( $file, '..' ) || str_contains( $file, '/' ) || ! str_ends_with( $file, '.php' ) || ! preg_match( '#^[A-Za-z0-9_.-]+$#', $file ) ) {
			return new WP_Error( 'wp_codebox_browser_mu_plugin_file_invalid', 'Browser mu-plugin files must be safe PHP filenames.', array( 'status' => 400, 'index' => $index ) );
		}

		$source_path = self::browser_clean_path( (string) ( $mu_plugin['path'] ?? '' ) );
		$source_url  = trim( (string) ( $mu_plugin['url'] ?? '' ) );
		$package     = null;
		$provenance  = array();
		if ( '' !== $source_path || '' !== $source_url ) {
			if ( '' === $slug ) {
				return new WP_Error( 'wp_codebox_browser_mu_plugin_slug_missing', 'Packaged browser mu-plugin specs require a slug.', array( 'status' => 400, 'index' => $index ) );
			}

			if ( '' !== $source_path && is_file( $source_path ) && str_ends_with( strtolower( $source_path ), '.zip' ) ) {
				$package    = self::browser_package_local_archive( $slug, $source_path, $index, (string) ( $mu_plugin['sha256'] ?? '' ), 'plugin' );
				$provenance = array(
					'schema' => 'wp-codebox/browser-mu-plugin-provenance/v1',
					'source' => 'runtime-mu-plugin-package-path',
					'path'   => $source_path,
				);
			} elseif ( '' !== $source_path && is_dir( $source_path ) ) {
				$package    = self::browser_package_component_plugin( $slug, $source_path );
				$provenance = array(
					'schema' => 'wp-codebox/browser-mu-plugin-provenance/v1',
					'source' => 'runtime-mu-plugin-path',
					'path'   => $source_path,
				);
			} elseif ( '' !== $source_url && ! empty( $mu_plugin['local_package'] ) ) {
				$source = self::browser_local_plugin_url( $source_url, $index );
				if ( is_wp_error( $source ) ) {
					return $source;
				}

				$sha256 = strtolower( trim( (string) ( $mu_plugin['sha256'] ?? '' ) ) );
				if ( '' !== $sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $sha256 ) ) {
					return new WP_Error( 'wp_codebox_browser_mu_plugin_sha256_invalid', 'Browser mu-plugin sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
				}

				$package    = array(
					'url'       => $source['url'],
					'fetch_url' => $source['url'],
					'path'      => '',
					'sha256'    => $sha256,
				);
				$provenance = array(
					'schema' => 'wp-codebox/browser-mu-plugin-provenance/v1',
					'source' => 'runtime-mu-plugin-local-package-url',
					'url'    => $source_url,
				);
			} elseif ( '' !== $source_url ) {
				$package    = self::browser_remote_mu_plugin_package( $slug, $source_url, $index, (string) ( $mu_plugin['sha256'] ?? '' ) );
				$provenance = array(
					'schema' => 'wp-codebox/browser-mu-plugin-provenance/v1',
					'source' => 'runtime-mu-plugin-remote-package',
					'url'    => $source_url,
				);
			} else {
				return new WP_Error( 'wp_codebox_browser_mu_plugin_path_missing', 'Browser mu-plugin path does not exist.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
			}

			if ( is_wp_error( $package ) ) {
				return $package;
			}
		}

		$content = (string) ( $mu_plugin['content'] ?? '' );
		if ( null === $package && '' === trim( $content ) ) {
			return new WP_Error( 'wp_codebox_browser_mu_plugin_content_missing', 'Browser mu-plugin content is required.', array( 'status' => 400, 'index' => $index ) );
		}

		$target_folder = sanitize_key( (string) ( $mu_plugin['targetFolderName'] ?? $slug ) );
		$entry         = ltrim( str_replace( '\\', '/', (string) ( $mu_plugin['entry'] ?? ( '' !== $target_folder ? $target_folder . '.php' : '' ) ) ), '/' );
		if ( null !== $package && ( '' === $target_folder || '' === $entry || str_contains( $entry, '..' ) || str_starts_with( $entry, '/' ) || ! str_ends_with( $entry, '.php' ) ) ) {
			return new WP_Error( 'wp_codebox_browser_mu_plugin_entry_invalid', 'Packaged browser mu-plugins require a safe PHP entry file.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
		}

		$normalized[] = array_filter( array(
			'slug'            => '' !== $slug ? $slug : self::safe_key( basename( $file, '.php' ) ),
			'file'            => $file,
			'path'            => '/wordpress/wp-content/mu-plugins/' . $file,
			'content'         => $content,
			'url'             => is_array( $package ) ? $package['url'] : '',
			'sha256'          => is_array( $package ) ? $package['sha256'] : '',
			'local_package_fetch_url' => is_array( $package ) ? $package['fetch_url'] : '',
			'targetFolderName' => $target_folder,
			'entry'           => $entry,
			'local_package'   => null !== $package,
			'provenance'      => array_filter( array_merge( $provenance, array( 'sha256' => is_array( $package ) ? $package['sha256'] : '' ) ) ),
			'readiness'       => 'compiled',
		), static fn( mixed $value ): bool => null !== $value && '' !== $value && array() !== $value );
	}

	return $normalized;
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string} | WP_Error */
private static function browser_remote_mu_plugin_package( string $slug, string $url, int $index, string $expected_sha256 = '' ): array|WP_Error {
	$sha256 = strtolower( trim( $expected_sha256 ) );
	if ( '' !== $sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_mu_plugin_sha256_invalid', 'Browser mu-plugin sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
	}

	return self::browser_package_remote_plugin( $slug, $url, $index, $sha256 );
}

/** @param array<int,mixed> $themes Theme dependency specs. @return array<int,array<string,mixed>>|WP_Error */
private static function normalize_browser_themes( array $themes ): array|WP_Error {
	$normalized = array();
	foreach ( $themes as $index => $theme ) {
		if ( ! is_array( $theme ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_invalid', 'Each browser theme must be an object.', array( 'status' => 400, 'index' => $index ) );
		}

		$slug  = self::safe_key( (string) ( $theme['slug'] ?? '' ) );
		$url   = trim( (string) ( $theme['url'] ?? '' ) );
		$path  = self::browser_clean_path( (string) ( $theme['path'] ?? '' ) );
		$package_mode = (string) ( $theme['package'] ?? '' );
		$files = is_array( $theme['files'] ?? null ) ? $theme['files'] : array();
		if ( '' === $slug ) {
			return new WP_Error( 'wp_codebox_browser_theme_slug_missing', 'Browser theme slug is required.', array( 'status' => 400, 'index' => $index ) );
		}
		if ( '' === $url && '' === $path && empty( $files ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_source_missing', 'Browser themes require a zip URL, path, or files.', array( 'status' => 400, 'index' => $index ) );
		}

		$source = null;
		$package = null;
		if ( '' !== $path ) {
			if ( ! is_dir( $path ) ) {
				return new WP_Error( 'wp_codebox_browser_theme_path_missing', 'Browser theme path does not exist.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
			}

			$package = self::browser_package_component_archive( $slug, $path, 'theme' );
			if ( is_wp_error( $package ) ) {
				return $package;
			}
			$source = array(
				'url'    => $package['url'],
				'origin' => str_starts_with( $package['url'], 'data:' ) ? 'data:' : '',
				'host'   => str_starts_with( $package['url'], 'data:' ) ? 'data' : '',
				'source' => 'runtime-theme-path',
				'path'   => $path,
			);
		} elseif ( '' !== $url && 'browser' !== $package_mode ) {
			$package = self::browser_package_remote_theme( $slug, $url, $index, (string) ( $theme['sha256'] ?? '' ) );
			if ( is_wp_error( $package ) ) {
				return $package;
			}
			$source = array(
				'url'    => $package['url'],
				'origin' => str_starts_with( $package['url'], 'data:' ) ? 'data:' : '',
				'host'   => str_starts_with( $package['url'], 'data:' ) ? 'data' : '',
				'source' => 'runtime-theme-remote-package',
				'remote_url' => $url,
			);
		} elseif ( '' !== $url ) {
			$source = self::browser_theme_url( $url, $index );
			if ( is_wp_error( $source ) ) {
				return $source;
			}
			$source['source'] = 'runtime-theme-url';
		}

		$normalized_files = self::normalize_browser_theme_files( $files, $slug, $index );
		if ( is_wp_error( $normalized_files ) ) {
			return $normalized_files;
		}

		$normalized[] = array_filter(
			array(
				'slug'       => $slug,
				'url'        => $source['url'] ?? '',
				'sha256'     => is_array( $package ) ? $package['sha256'] : strtolower( trim( (string) ( $theme['sha256'] ?? '' ) ) ),
				'local_package' => is_array( $package ),
				'local_package_fetch_url' => is_array( $package ) ? $package['fetch_url'] : '',
				'activate'   => ! array_key_exists( 'activate', $theme ) || (bool) $theme['activate'],
				'files'      => $normalized_files,
				'readiness'  => 'compiled',
				'provenance' => $source ? array_filter( array( 'schema' => 'wp-codebox/browser-theme-provenance/v1', 'url' => $source['url'], 'origin' => $source['origin'] ?? '', 'host' => $source['host'] ?? '', 'source' => $source['source'] ?? '', 'path' => $source['path'] ?? '', 'remote_url' => $source['remote_url'] ?? '', 'sha256' => is_array( $package ) ? $package['sha256'] : '' ) ) : array(),
			),
			static fn( mixed $value ): bool => array() !== $value && '' !== $value
		);
	}

	return $normalized;
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string}|WP_Error */
private static function browser_package_remote_theme( string $slug, string $url, int $index, string $expected_sha256 = '' ): array|WP_Error {
	$source = self::browser_remote_theme_package_url( $url, $index );
	if ( is_wp_error( $source ) ) {
		return $source;
	}

	$expected_sha256 = strtolower( trim( $expected_sha256 ) );
	if ( '' !== $expected_sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $expected_sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_theme_sha256_invalid', 'Browser theme sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index ) );
	}

	return self::browser_package_remote_archive( $slug, $source['url'], $index, $expected_sha256, 'theme' );
}

/** @param array<int,mixed> $files Theme file specs. @return array<int,array<string,string>>|WP_Error */
private static function normalize_browser_theme_files( array $files, string $slug, int $theme_index ): array|WP_Error {
	$normalized = array();
	foreach ( $files as $index => $file ) {
		if ( ! is_array( $file ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_file_invalid', 'Each browser theme file must be an object.', array( 'status' => 400, 'theme_index' => $theme_index, 'index' => $index ) );
		}

		$path = trim( (string) ( $file['path'] ?? '' ) );
		if ( '' === $path || str_contains( $path, '..' ) || str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_file_path_invalid', 'Browser theme file paths must be safe relative paths.', array( 'status' => 400, 'theme_index' => $theme_index, 'index' => $index ) );
		}

		$normalized[] = array(
			'path'            => $path,
			'playground_path' => '/wordpress/wp-content/themes/' . $slug . '/' . $path,
			'content'         => (string) ( $file['content'] ?? '' ),
		);
	}

	return $normalized;
}

/** @param array<int,mixed> $operations Bootstrap operation specs. @return array<int,array<string,mixed>>|WP_Error */
private static function normalize_browser_bootstrap( array $operations ): array|WP_Error {
	$normalized = array();
	foreach ( $operations as $index => $operation ) {
		if ( ! is_array( $operation ) ) {
			return new WP_Error( 'wp_codebox_browser_bootstrap_invalid', 'Each browser bootstrap operation must be an object.', array( 'status' => 400, 'index' => $index ) );
		}

		$name = self::safe_key( (string) ( $operation['operation'] ?? $operation['name'] ?? '' ) );
		if ( ! in_array( $name, array( 'set_option', 'activate_plugin', 'activate_theme', 'flush_rewrite_rules' ), true ) ) {
			return new WP_Error( 'wp_codebox_browser_bootstrap_operation_invalid', 'Browser bootstrap operation is not supported.', array( 'status' => 400, 'index' => $index, 'operation' => $name ) );
		}

		$normalized[] = array(
			'operation' => $name,
			'args'      => is_array( $operation['args'] ?? null ) ? $operation['args'] : array_diff_key( $operation, array( 'operation' => true, 'name' => true ) ),
			'readiness' => 'compiled',
		);
	}

	return $normalized;
}

/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
private static function browser_playground( array $input ): array|WP_Error {
	$playground = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
	$client     = self::browser_trusted_url(
		(string) ( $playground['client_module_url'] ?? 'https://playground.wordpress.net/client/index.js' ),
		'client_module_url',
		'wp_codebox_browser_playground_allowed_origins',
		array( 'https://playground.wordpress.net', 'https://playground.automattic.ai' )
	);
	if ( is_wp_error( $client ) ) {
		return $client;
	}

	$remote = self::browser_trusted_url(
		(string) ( $playground['remote_url'] ?? 'https://playground.wordpress.net/remote.html' ),
		'remote_url',
		'wp_codebox_browser_playground_allowed_origins',
		array( 'https://playground.wordpress.net', 'https://playground.automattic.ai' )
	);
	if ( is_wp_error( $remote ) ) {
		return $remote;
	}

	$default_cors_proxy_url = (string) apply_filters( 'wp_codebox_browser_playground_default_cors_proxy_url', 'https://wordpress-playground-cors-proxy.net/?', $playground );
	$cors_proxy_url         = (string) ( $playground['cors_proxy_url'] ?? $playground['corsProxy'] ?? $default_cors_proxy_url );
	$cors_proxy             = array( 'url' => '', 'origin' => '', 'host' => '' );
	if ( '' !== trim( $cors_proxy_url ) ) {
		$cors_proxy = self::browser_trusted_url(
			$cors_proxy_url,
			'cors_proxy_url',
			'wp_codebox_browser_playground_cors_proxy_allowed_origins',
			array( 'https://wordpress-playground-cors-proxy.net', 'https://playground.wordpress.net', 'https://playground.automattic.ai' )
		);
		if ( is_wp_error( $cors_proxy ) ) {
			return $cors_proxy;
		}
	}

	$playground['client_module_url'] = $client['url'];
	$playground['remote_url']        = $remote['url'];
	$playground['cors_proxy_url']    = $cors_proxy['url'];
	$playground['provenance']        = array(
		'schema'            => 'wp-codebox/browser-playground-provenance/v1',
		'client_module_url' => $client,
		'remote_url'        => $remote,
		'cors_proxy_url'    => $cors_proxy,
	);

	return $playground;
}

/** @return array{url:string,origin:string,host:string} | WP_Error */
private static function browser_trusted_url( string $url, string $field, string $filter, array $default_allowed_origins ): array|WP_Error {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return new WP_Error( 'wp_codebox_browser_url_invalid', 'Browser Playground URL must be absolute.', array( 'status' => 400, 'field' => $field ) );
	}

	$scheme = strtolower( (string) $parts['scheme'] );
	if ( 'https' !== $scheme ) {
		return new WP_Error( 'wp_codebox_browser_url_insecure', 'Browser Playground URL must use https://.', array( 'status' => 400, 'field' => $field ) );
	}

	$origin  = self::url_origin( $parts );
	$allowed = self::normalized_origins( apply_filters( $filter, $default_allowed_origins, $field, $url ) );
	if ( ! in_array( $origin, $allowed, true ) ) {
		return new WP_Error( 'wp_codebox_browser_origin_not_allowed', 'Browser Playground URL origin is not allowed.', array( 'status' => 400, 'field' => $field, 'origin' => $origin ) );
	}

	return array(
		'url'    => $url,
		'origin' => $origin,
		'host'   => strtolower( (string) $parts['host'] ),
	);
}

/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
private static function browser_plugins( array $input ): array|WP_Error {
	$plugins = is_array( $input['browser_plugins'] ?? null ) ? $input['browser_plugins'] : array();
	return self::normalize_browser_plugins( $plugins, 'browser_plugins' );
}

/** @param array<string,mixed> $input Ability input. @param array<int,array<string,mixed>> $browser_plugins Browser plugin specs. @return array<string,mixed>|WP_Error */
private static function browser_runtime_dependencies( array $input, array $browser_plugins, ?WP_Codebox_Runtime_Dependency_Plan $dependency_plan = null ): array|WP_Error {
	$runtime = is_array( $input['runtime'] ?? null ) ? $input['runtime'] : array();
	$provider_plugin_specs = $dependency_plan instanceof WP_Codebox_Runtime_Dependency_Plan ? $dependency_plan->browser_provider_plugin_specs() : self::browser_provider_plugin_specs( $input );
	$runtime_plugin_specs = self::browser_runtime_plugin_specs( array_merge( $provider_plugin_specs, is_array( $runtime['plugins'] ?? null ) ? $runtime['plugins'] : array() ) );
	if ( is_wp_error( $runtime_plugin_specs ) ) {
		return $runtime_plugin_specs;
	}

	$runtime_plugins = self::normalize_browser_plugins( $runtime_plugin_specs, 'runtime.plugins' );
	if ( is_wp_error( $runtime_plugins ) ) {
		return $runtime_plugins;
	}

	$mu_plugins = self::normalize_browser_mu_plugins( is_array( $runtime['mu_plugins'] ?? null ) ? $runtime['mu_plugins'] : array() );
	if ( is_wp_error( $mu_plugins ) ) {
		return $mu_plugins;
	}

	$themes = self::normalize_browser_themes( is_array( $runtime['themes'] ?? null ) ? $runtime['themes'] : array() );
	if ( is_wp_error( $themes ) ) {
		return $themes;
	}

	$bootstrap = self::normalize_browser_bootstrap( is_array( $runtime['bootstrap'] ?? null ) ? $runtime['bootstrap'] : array() );
	if ( is_wp_error( $bootstrap ) ) {
		return $bootstrap;
	}

	$declared_components = is_array( $runtime['components'] ?? null ) ? $runtime['components'] : array();
	$component_plugins   = self::browser_component_plugins( $input, array_merge( $browser_plugins, $runtime_plugins ), $declared_components );
	if ( is_wp_error( $component_plugins ) ) {
		return $component_plugins;
	}

	$plugins = self::dedupe_browser_plugins( array_merge( $browser_plugins, $runtime_plugins, $component_plugins ) );
	$prepared = self::browser_prepared_runtime_contract( $runtime, $plugins, $mu_plugins, $themes, $bootstrap, $input );
	if ( is_wp_error( $prepared ) ) {
		return $prepared;
	}

	return array(
		'schema'                 => 'wp-codebox/browser-runtime-dependencies/v1',
		'plugins'                => $plugins,
		'components'             => self::browser_runtime_component_slugs( $declared_components, self::browser_component_plugins_required( $input ) ),
		'mu_plugins'             => $mu_plugins,
		'themes'                 => $themes,
		'bootstrap'              => $bootstrap,
		'prepared_runtime'       => $prepared,
		'component_plugins'      => count( $component_plugins ),
		'browser_plugins'        => count( $browser_plugins ),
		'summary'                => array(
			'plugins'    => count( $plugins ),
			'mu_plugins' => count( $mu_plugins ),
			'themes'     => count( $themes ),
			'bootstrap'  => count( $bootstrap ),
		),
	);
}

/** @return array<string,mixed>|WP_Error */
private static function browser_prepared_runtime_contract( array $runtime, array $plugins, array $mu_plugins, array $themes, array $bootstrap, array $input ): array|WP_Error {
	$prepared = is_array( $runtime['prepared'] ?? null ) ? $runtime['prepared'] : ( is_array( $runtime['prepared_runtime'] ?? null ) ? $runtime['prepared_runtime'] : array() );
	$enabled  = array_key_exists( 'enabled', $prepared ) ? (bool) $prepared['enabled'] : ! empty( $prepared );
	if ( ! $enabled ) {
		return array(
			'schema' => 'wp-codebox/browser-prepared-runtime/v1',
			'status' => 'disabled',
		);
	}

	$hash_input = array(
		'plugins'    => self::browser_prepared_runtime_hashable_dependencies( $plugins ),
		'mu_plugins' => self::browser_prepared_runtime_hashable_dependencies( $mu_plugins ),
		'themes'     => self::browser_prepared_runtime_hashable_dependencies( $themes ),
		'bootstrap'  => $bootstrap,
		'blueprint'  => is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(),
		'site_blueprint_artifact' => is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array(),
		'playground' => array(
			'wp'  => (string) ( $input['playground']['wp'] ?? 'latest' ),
			'php' => (string) ( $input['playground']['php'] ?? 'latest' ),
		),
	);
	$input_hash = hash( 'sha256', 'wp-codebox/browser-prepared-runtime-input/v1' . "\n" . self::stable_json( $hash_input ) );
	$cache_key = self::safe_key( (string) ( $prepared['cache_key'] ?? $prepared['key'] ?? '' ) );
	if ( '' === $cache_key ) {
		$cache_key = 'prepared-' . substr( $input_hash, 0, 16 );
	}

	$prepared_input_hash = strtolower( trim( (string) ( $prepared['input_hash'] ?? $prepared['hash'] ?? '' ) ) );
	if ( '' !== $prepared_input_hash && ! preg_match( '/^[a-f0-9]{64}$/', $prepared_input_hash ) ) {
		return new WP_Error( 'wp_codebox_prepared_runtime_hash_invalid', 'Prepared runtime input_hash must be a 64-character hex digest.', array( 'status' => 400 ) );
	}

	$snapshot = is_array( $prepared['snapshot'] ?? null ) ? $prepared['snapshot'] : array();
	$prepared_blueprint = is_array( $prepared['blueprint'] ?? null ) ? $prepared['blueprint'] : ( is_array( $snapshot['blueprint'] ?? null ) ? $snapshot['blueprint'] : array() );
	$status = ( ! empty( $prepared_blueprint ) && hash_equals( $input_hash, $prepared_input_hash ) ) ? 'hit' : 'miss';

	return array_filter(
		array(
			'schema'          => 'wp-codebox/browser-prepared-runtime/v1',
			'status'          => $status,
			'cache_key'       => $cache_key,
			'input_hash'      => $input_hash,
			'provided_hash'   => $prepared_input_hash,
			'strategy'        => (string) ( $prepared['strategy'] ?? 'prepared-blueprint' ),
			'blueprint'       => $prepared_blueprint,
			'snapshot'        => $snapshot,
			'invalidation'    => array(
				'reason' => 'hit' === $status ? 'input-hash-match' : ( '' === $prepared_input_hash ? 'missing-input-hash' : 'input-hash-mismatch' ),
			),
		),
		static fn( mixed $value ): bool => array() !== $value && '' !== $value
	);
}

private static function browser_prepared_runtime_hashable_dependencies( array $items ): array {
	return array_map(
		static function ( array $item ): array {
			unset( $item['url'], $item['local_package_fetch_url'], $item['provenance'] );
			return $item;
		},
		$items
	);
}

/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>> */
private static function browser_provider_plugin_specs( array $input ): array {
	return array_map(
		static fn( string $path ): array => array(
			'slug'     => self::safe_key( basename( $path ) ),
			'path'     => $path,
			'activate' => true,
			'provenance' => array(
				'source' => 'provider-plugin-path',
			),
		),
		self::browser_provider_plugin_paths( $input )
	);
}

/** @param array<int,mixed> $plugins Runtime plugin specs. @return array<int,array<string,mixed>>|WP_Error */
private static function browser_runtime_plugin_specs( array $plugins ): array|WP_Error {
	$resolved = array();

	foreach ( $plugins as $index => $plugin ) {
		if ( ! is_array( $plugin ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_invalid', 'Each browser plugin must be an object.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index ) );
		}

		$resource = (string) ( $plugin['resource'] ?? 'url' );
		$path     = 'git:directory' === $resource ? '' : self::browser_clean_path( (string) ( $plugin['path'] ?? '' ) );
		$package  = (string) ( $plugin['package'] ?? '' );
		if ( 'url' === $resource && '' === $path && 'browser' !== $package && '' === trim( (string) ( $plugin['url'] ?? '' ) ) ) {
			$host_dir = self::browser_host_runtime_plugin_dir( (string) ( $plugin['slug'] ?? '' ) );
			if ( '' !== $host_dir ) {
				$path = $host_dir;
			}
		}
		if ( 'url' === $resource && '' === $path && 'browser' !== $package ) {
			$slug = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
			if ( '' === $slug ) {
				return new WP_Error( 'wp_codebox_browser_plugin_slug_missing', 'Packaged browser runtime plugin specs require a slug.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index ) );
			}

			$package = self::browser_package_remote_plugin( $slug, (string) ( $plugin['url'] ?? '' ), $index, (string) ( $plugin['sha256'] ?? '' ) );
			if ( is_wp_error( $package ) ) {
				return $package;
			}

			$resolved[] = array_merge(
				$plugin,
				array(
					'slug'                    => $slug,
					'url'                     => $package['url'],
					'local_package_fetch_url' => $package['fetch_url'],
					'targetFolderName'        => self::safe_key( (string) ( $plugin['targetFolderName'] ?? $slug ) ),
					'sha256'                  => $package['sha256'],
					'local_package'           => true,
					'provenance'              => array(
						'schema' => 'wp-codebox/browser-plugin-provenance/v1',
						'source' => 'runtime-plugin-remote-package',
						'url'    => (string) ( $plugin['url'] ?? '' ),
					),
				)
			);
			continue;
		}

		if ( '' === $path ) {
			$resolved[] = $plugin;
			continue;
		}

		$slug = self::safe_key( (string) ( $plugin['slug'] ?? basename( $path ) ) );
		if ( '' === $slug ) {
			return new WP_Error( 'wp_codebox_browser_plugin_slug_missing', 'Browser plugin path specs require a slug.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index ) );
		}

		if ( ! is_dir( $path ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_path_missing', 'Browser plugin path does not exist.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index, 'slug' => $slug ) );
		}

		$package = self::browser_package_component_plugin( $slug, $path );
		if ( is_wp_error( $package ) ) {
			return $package;
		}

		$resolved[] = array_merge(
			$plugin,
			array(
				'slug'                    => $slug,
				'url'                     => $package['url'],
				'local_package_fetch_url' => $package['fetch_url'],
				'targetFolderName'        => self::safe_key( (string) ( $plugin['targetFolderName'] ?? $slug ) ),
				'sha256'                  => $package['sha256'],
				'local_package'           => true,
				'provenance'              => array(
					'schema' => 'wp-codebox/browser-plugin-provenance/v1',
					'source' => 'runtime-plugin-path',
					'path'   => $path,
				),
			)
		);
	}

	return $resolved;
}

/** @param array<string,mixed> $input Ability input. @param array<int,array<string,mixed>> $declared_plugins Caller/runtime plugin specs. @param array<int,mixed> $declared_components Caller/runtime component refs. @return array<int,array<string,mixed>>|WP_Error */
private static function browser_component_plugins( array $input, array $declared_plugins, array $declared_components ): array|WP_Error {
	$components_required = self::browser_component_plugins_required( $input );
	if ( ! $components_required && empty( $declared_components ) ) {
		return array();
	}

	$contracts = self::browser_component_contracts( $input );
	$registry = self::browser_runtime_component_registry();
	$declared_slugs = array_values(
		array_filter(
			array_map( static fn( array $plugin ): string => self::safe_key( (string) ( $plugin['slug'] ?? '' ) ), $declared_plugins )
		)
	);
	$component_slugs = self::browser_runtime_component_slugs( $declared_components, $components_required );

	$plugins = array();
	foreach ( $component_slugs as $slug ) {
		if ( in_array( $slug, $declared_slugs, true ) ) {
			continue;
		}

		$key  = self::browser_runtime_component_key( $slug );
		$contract = is_array( $contracts[ $slug ] ?? null ) ? $contracts[ $slug ] : ( is_array( $contracts[ $key ] ?? null ) ? $contracts[ $key ] : array() );
		$path = (string) ( $contract['path'] ?? '' );
		$source = '' !== $path ? 'host-component-path' : '';
		if ( '' === $path ) {
			$path   = self::browser_host_runtime_plugin_dir( $slug );
			$source = '' !== $path ? 'host-installed-plugin' : '';
		}
		if ( '' !== $path ) {
			if ( ! is_dir( $path ) ) {
				return new WP_Error( 'wp_codebox_browser_component_path_missing', 'Browser runtime component path does not exist.', array( 'status' => 400, 'slug' => $slug, 'path' => $path ) );
			}

			$package = self::browser_package_component_plugin( $slug, $path );
			if ( is_wp_error( $package ) ) {
				return $package;
			}

			$plugins[] = array(
				'url'                     => $package['url'],
				'slug'                    => $slug,
				'activate'                => (bool) ( $contract['activate'] ?? true ),
				'local_package'           => true,
				'local_package_fetch_url' => $package['fetch_url'],
				'targetFolderName'        => $slug,
				'sha256'                  => $package['sha256'],
				'provenance'              => array(
					'schema' => 'wp-codebox/browser-component-plugin-provenance/v1',
					'source' => $source,
					'sha256' => $package['sha256'],
				),
			);
			continue;
		}

		$component = is_array( $registry[ $slug ] ?? null ) ? $registry[ $slug ] : array();
		if ( empty( $component ) ) {
			self::browser_runtime_component_unresolved( $slug );
			continue;
		}

		$component['slug'] = $slug;
		if ( 'url' === (string) ( $component['resource'] ?? 'url' ) && 'browser' !== (string) ( $component['package'] ?? '' ) ) {
			$package = self::browser_package_remote_plugin( $slug, (string) ( $component['url'] ?? '' ), count( $plugins ), (string) ( $component['sha256'] ?? '' ) );
			if ( is_wp_error( $package ) ) {
				return $package;
			}

			$component['url']                     = $package['url'];
			$component['local_package']           = true;
			$component['local_package_fetch_url'] = $package['fetch_url'];
			$component['targetFolderName']        = self::safe_key( (string) ( $component['targetFolderName'] ?? $slug ) );
			$component['sha256']                  = $package['sha256'];
		}

		$normalized = self::normalize_browser_plugins( array( $component ), 'runtime.components' );
		if ( is_wp_error( $normalized ) ) {
			return $normalized;
		}

		$plugins[] = $normalized[0];
	}

	return $plugins;
}

/** @return array<int,string> */
private static function browser_runtime_component_slugs( array $declared_components, bool $include_required ): array {
	$slugs = array();
	if ( $include_required ) {
		/**
		 * Filters the set of component slugs the browser runtime always installs.
		 *
		 * The generic runtime has no built-in required components; consumer
		 * integrations (e.g. an agent runtime) register the plugin slugs their
		 * sandbox depends on. Slugs must have a matching entry in the component
		 * registry (see the wp_codebox_browser_runtime_component_registry filter)
		 * to resolve to an installable source.
		 *
		 * @param array<int,string> $slugs Required component slugs. Default empty.
		 */
		$required = function_exists( 'apply_filters' )
			? apply_filters( 'wp_codebox_browser_runtime_required_components', array() )
			: array();

		if ( is_array( $required ) ) {
			foreach ( $required as $required_slug ) {
				$normalized = self::safe_key( (string) $required_slug );
				if ( '' !== $normalized ) {
					$slugs[] = $normalized;
				}
			}
		}
	}

	foreach ( $declared_components as $component ) {
		$slug = is_array( $component ) ? self::safe_key( (string) ( $component['slug'] ?? $component['component'] ?? $component['name'] ?? '' ) ) : self::safe_key( (string) $component );
		if ( '' !== $slug ) {
			$slugs[] = $slug;
		}
	}

	return array_values( array_unique( $slugs ) );
}

private static function browser_runtime_component_key( string $slug ): string {
	return str_replace( '-', '_', self::safe_key( $slug ) );
}

/** @return array<string,array<string,mixed>> */
private static function browser_runtime_component_registry(): array {
	/**
	 * Filters the browser runtime component registry: a map of component slug
	 * to an installable source descriptor (resource, url, targetFolderName,
	 * activate, provenance).
	 *
	 * The generic runtime ships no built-in components — it must not know which
	 * downstream plugins or vendor release URLs exist. Consumer integrations
	 * register their own components (and pair them with the
	 * wp_codebox_browser_runtime_required_components filter when a component
	 * should always be installed).
	 *
	 * @param array<string,array<string,mixed>> $registry Component registry. Default empty.
	 */
	$registry = function_exists( 'apply_filters' )
		? apply_filters( 'wp_codebox_browser_runtime_component_registry', array() )
		: array();

	return is_array( $registry ) ? $registry : array();
}

/**
 * Resolves a runtime plugin/component slug to a host-installed plugin directory.
 *
 * The agent runtime provisions its substrate (e.g. agents-api and the selected
 * AI provider plugin) into the sandbox from the host's own installed copies, so
 * consumers select the runtime profile and supply domain inputs only — they
 * never hand-inject runtime plugin sources. This is the default source strategy;
 * an explicit component contract path or the browser runtime component registry
 * still take precedence, and supply a source for plugins not installed locally.
 *
 * @param string $slug Plugin slug.
 * @return string Absolute host plugin directory, or '' when not installed.
 */
private static function browser_host_runtime_plugin_dir( string $slug ): string {
	$slug = self::safe_key( $slug );
	if ( '' === $slug ) {
		return '';
	}

	$roots = array();
	if ( defined( 'WP_PLUGIN_DIR' ) ) {
		$roots[] = (string) WP_PLUGIN_DIR;
	}

	/**
	 * Filters the host plugin roots searched when resolving a runtime plugin
	 * slug to an installed source. Defaults to WP_PLUGIN_DIR. A host or deploy
	 * can add roots so runtime plugins that live outside the standard plugin
	 * directory still resolve to an installable source.
	 *
	 * @param array<int,string> $roots Host plugin roots.
	 * @param string            $slug  Plugin slug being resolved.
	 */
	if ( function_exists( 'apply_filters' ) ) {
		$roots = apply_filters( 'wp_codebox_browser_runtime_host_plugin_roots', $roots, $slug );
	}

	foreach ( is_array( $roots ) ? $roots : array() as $root ) {
		$root = trim( (string) $root );
		if ( '' === $root ) {
			continue;
		}

		$dir = self::browser_clean_path( rtrim( $root, '/\\' ) . DIRECTORY_SEPARATOR . $slug );
		if ( '' !== $dir && is_dir( $dir ) ) {
			return $dir;
		}
	}

	return '';
}

/**
 * Surfaces a required runtime component that has no resolvable source.
 *
 * A component reaches this path when it is neither installed on the host nor
 * backed by a component contract path or registry source. The host or deploy
 * must provide a source (via wp_codebox_browser_runtime_component_registry,
 * wp_codebox_component_contracts, or wp_codebox_browser_runtime_host_plugin_roots);
 * the runtime sandbox cannot fabricate one.
 *
 * @param string $slug Unresolved component slug.
 */
private static function browser_runtime_component_unresolved( string $slug ): void {
	$slug = self::safe_key( $slug );
	if ( '' === $slug ) {
		return;
	}

	if ( function_exists( 'do_action' ) ) {
		do_action( 'wp_codebox_browser_runtime_component_unresolved', $slug );
	}

	if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
		error_log( sprintf( 'WP Codebox: browser runtime component "%s" has no resolvable source. Install it on the host or provide a source via the component registry/contract or host plugin roots filter.', $slug ) ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
	}
}

private static function browser_component_plugins_required( array $input ): bool {
	$provider_plugin_paths = is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array();
	$inherit               = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();
	$connectors            = is_array( $inherit['connectors'] ?? null ) ? $inherit['connectors'] : array();
	$secret_env            = is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array();

	return ! empty( $input['browser_runner'] ) || ! empty( $provider_plugin_paths ) || ! empty( $connectors ) || ! empty( $secret_env );
}

/** @param array<string,mixed> $input Ability input. @return array<string,array<string,mixed>> */
private static function browser_component_contracts( array $input ): array {
	$contracts = array();
	foreach ( self::browser_configured_component_contracts() as $contract ) {
		if ( is_array( $contract ) ) {
			$contracts[] = $contract;
		}
	}
	foreach ( is_array( $input['component_contracts'] ?? null ) ? $input['component_contracts'] : array() as $contract ) {
		if ( is_array( $contract ) ) {
			$contracts[] = $contract;
		}
	}

	$normalized = array();
	foreach ( $contracts as $contract ) {
		$slug = self::safe_key( (string) ( $contract['slug'] ?? $contract['component'] ?? $contract['name'] ?? '' ) );
		if ( '' === $slug ) {
			continue;
		}

		$normalized[ $slug ] = array_merge(
			$contract,
			array(
				'slug' => $slug,
				'path' => self::browser_clean_path( (string) ( $contract['path'] ?? $contract['source'] ?? '' ) ),
			)
		);
	}

	return $normalized;
}

/** @return array<int,array<string,mixed>> */
private static function browser_configured_component_contracts(): array {
	$contracts = array();
	if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
		$option = get_site_option( 'wp_codebox_component_contracts', array() );
	} elseif ( function_exists( 'get_option' ) ) {
		$option = get_option( 'wp_codebox_component_contracts', array() );
	} else {
		$option = array();
	}

	if ( is_array( $option ) ) {
		$contracts = $option;
	}

	if ( function_exists( 'apply_filters' ) ) {
		$contracts = apply_filters( 'wp_codebox_component_contracts', $contracts );
	}

	return is_array( $contracts ) ? $contracts : array();
}

private static function browser_clean_path( string $path ): string {
	return WP_Codebox_Path_Policy::clean_browser_runtime_source_path( $path );
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string}|WP_Error */
private static function browser_package_component_plugin( string $slug, string $source_path ): array|WP_Error {
	return self::browser_package_component_archive( $slug, $source_path, 'plugin' );
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string}|WP_Error */
private static function browser_package_component_archive( string $slug, string $source_path, string $kind ): array|WP_Error {
	if ( ! class_exists( 'ZipArchive' ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_packager_missing', 'Browser runtime packaging requires ZipArchive.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$upload = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir(), 'baseurl' => '' );
	if ( ! is_array( $upload ) || empty( $upload['basedir'] ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_upload_dir_missing', 'Browser runtime packaging requires an upload directory.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$directory = 'theme' === $kind ? 'browser-runtime-themes' : 'browser-runtime-plugins';
	$base_dir = rtrim( (string) $upload['basedir'], '/\\' ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . $directory;
	if ( ! is_dir( $base_dir ) && ! mkdir( $base_dir, 0777, true ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_dir_failed', 'Could not create browser runtime package directory.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$package_id = substr( hash( 'sha256', $slug . "\n" . $source_path . "\n" . self::browser_component_source_fingerprint( $source_path ) ), 0, 16 );
	$zip_path   = $base_dir . DIRECTORY_SEPARATOR . $slug . '-' . $package_id . '.zip';
	if ( ! is_file( $zip_path ) ) {
		$result = self::write_browser_component_zip( $slug, $source_path, $zip_path, $kind );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
	}

	$base_url = is_array( $upload ) && ! empty( $upload['baseurl'] ) ? rtrim( (string) $upload['baseurl'], '/' ) : '';
	$url      = '' !== $base_url ? $base_url . '/wp-codebox/' . $directory . '/' . rawurlencode( basename( $zip_path ) ) : '';
	if ( '' === $url ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_url_missing', 'Browser runtime package URL is missing.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$sha256 = hash_file( 'sha256', $zip_path );
	if ( ! is_string( $sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_hash_failed', 'Could not hash browser runtime package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$safe_url     = self::browser_safe_local_package_url( $url );
	$delivery_url = self::browser_plugin_delivery_url( $zip_path, $safe_url, $slug );
	if ( is_wp_error( $delivery_url ) ) {
		return $delivery_url;
	}

	return array(
		'url'       => $delivery_url,
		'fetch_url' => $safe_url,
		'path'      => $zip_path,
		'sha256'    => $sha256,
	);
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string}|WP_Error */
private static function browser_package_remote_plugin( string $slug, string $url, int $index, string $expected_sha256 = '' ): array|WP_Error {
	$source = self::browser_remote_plugin_package_url( $url, $index );
	if ( is_wp_error( $source ) ) {
		return $source;
	}

	$expected_sha256 = strtolower( trim( $expected_sha256 ) );
	if ( '' !== $expected_sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $expected_sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_sha256_invalid', 'Browser plugin sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index ) );
	}

	return self::browser_package_remote_archive( $slug, $source['url'], $index, $expected_sha256, 'plugin' );
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string}|WP_Error */
private static function browser_package_local_archive( string $slug, string $source_path, int $index, string $expected_sha256, string $kind ): array|WP_Error {
	if ( ! is_file( $source_path ) || ! is_readable( $source_path ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_path_missing', 'Browser runtime package path does not exist.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
	}

	$source_sha256 = hash_file( 'sha256', $source_path );
	if ( ! is_string( $source_sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_hash_failed', 'Could not hash browser runtime package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$expected_sha256 = strtolower( trim( $expected_sha256 ) );
	if ( '' !== $expected_sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $expected_sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_sha256_invalid', 'Browser runtime package sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index, 'slug' => $slug ) );
	}

	if ( '' !== $expected_sha256 && ! hash_equals( $expected_sha256, $source_sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_hash_mismatch', 'Browser runtime package does not match the expected sha256.', array( 'status' => 400, 'slug' => $slug ) );
	}

	$upload = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir(), 'baseurl' => '' );
	if ( ! is_array( $upload ) || empty( $upload['basedir'] ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_upload_dir_missing', 'Browser runtime packaging requires an upload directory.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$directory = 'theme' === $kind ? 'browser-runtime-themes' : 'browser-runtime-plugins';
	$base_dir  = rtrim( (string) $upload['basedir'], '/\\' ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . $directory;
	if ( ! is_dir( $base_dir ) && ! mkdir( $base_dir, 0777, true ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_dir_failed', 'Could not create browser runtime package directory.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$package_id = substr( hash( 'sha256', $slug . "\n" . $source_path . "\n" . $source_sha256 ), 0, 16 );
	$zip_path   = $base_dir . DIRECTORY_SEPARATOR . $slug . '-' . $package_id . '.zip';
	if ( ! is_file( $zip_path ) && ! copy( $source_path, $zip_path ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_write_failed', 'Could not write browser runtime package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$base_url = is_array( $upload ) && ! empty( $upload['baseurl'] ) ? rtrim( (string) $upload['baseurl'], '/' ) : '';
	$url      = '' !== $base_url ? $base_url . '/wp-codebox/' . $directory . '/' . rawurlencode( basename( $zip_path ) ) : '';
	if ( '' === $url ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_url_missing', 'Browser runtime package URL is missing.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$safe_url     = self::browser_safe_local_package_url( $url );
	$delivery_url = self::browser_plugin_delivery_url( $zip_path, $safe_url, $slug );
	if ( is_wp_error( $delivery_url ) ) {
		return $delivery_url;
	}

	return array(
		'url'       => $delivery_url,
		'fetch_url' => $safe_url,
		'path'      => $zip_path,
		'sha256'    => $source_sha256,
	);
}

/** @return array{url:string,fetch_url:string,path:string,sha256:string}|WP_Error */
private static function browser_package_remote_archive( string $slug, string $url, int $index, string $expected_sha256, string $kind ): array|WP_Error {
	$upload = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir(), 'baseurl' => '' );
	if ( ! is_array( $upload ) || empty( $upload['basedir'] ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_upload_dir_missing', 'Browser runtime packaging requires an upload directory.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$directory = 'theme' === $kind ? 'browser-runtime-themes' : 'browser-runtime-plugins';
	$base_dir = rtrim( (string) $upload['basedir'], '/\\' ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . $directory;
	if ( ! is_dir( $base_dir ) && ! mkdir( $base_dir, 0777, true ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_dir_failed', 'Could not create browser runtime package directory.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$package_id = substr( hash( 'sha256', $slug . "\n" . $url . "\n" . $expected_sha256 ), 0, 16 );
	$zip_path   = $base_dir . DIRECTORY_SEPARATOR . $slug . '-' . $package_id . '.zip';
	if ( ! is_file( $zip_path ) ) {
		$downloaded = self::browser_download_remote_plugin( $url, $zip_path, $slug );
		if ( is_wp_error( $downloaded ) ) {
			return $downloaded;
		}
	}

	$sha256 = hash_file( 'sha256', $zip_path );
	if ( ! is_string( $sha256 ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_hash_failed', 'Could not hash browser runtime package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	if ( '' !== $expected_sha256 && ! hash_equals( $expected_sha256, $sha256 ) ) {
		@unlink( $zip_path );
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_hash_mismatch', 'Downloaded browser runtime package does not match the expected sha256.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$base_url = is_array( $upload ) && ! empty( $upload['baseurl'] ) ? rtrim( (string) $upload['baseurl'], '/' ) : '';
	$url      = '' !== $base_url ? $base_url . '/wp-codebox/' . $directory . '/' . rawurlencode( basename( $zip_path ) ) : '';
	if ( '' === $url ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_package_url_missing', 'Browser runtime package URL is missing.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$safe_url     = self::browser_safe_local_package_url( $url );
	$delivery_url = self::browser_plugin_delivery_url( $zip_path, $safe_url, $slug );
	if ( is_wp_error( $delivery_url ) ) {
		return $delivery_url;
	}

	return array(
		'url'       => $delivery_url,
		'fetch_url' => $safe_url,
		'path'      => $zip_path,
		'sha256'    => $sha256,
	);
}

private static function browser_plugin_delivery_url( string $zip_path, string $public_url, string $slug ): string|WP_Error {
	$max_bytes = (int) apply_filters( 'wp_codebox_browser_plugin_data_url_max_bytes', 16 * 1024 * 1024, $zip_path, $slug );
	$size      = filesize( $zip_path );
	if ( is_int( $size ) && $size > $max_bytes && ! self::browser_plugin_uses_loopback_url( $public_url ) ) {
		return $public_url;
	}

	$contents = file_get_contents( $zip_path );
	if ( ! is_string( $contents ) || '' === $contents ) {
		return new WP_Error( 'wp_codebox_browser_plugin_package_read_failed', 'Could not read browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	return 'data:application/zip;base64,' . base64_encode( $contents );
}

private static function browser_safe_local_package_url( string $url ): string {
	$parts = wp_parse_url( $url );
	$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
	if ( ! is_array( $parts ) || ! in_array( $scheme, array( 'http', 'https' ), true ) || ! self::is_loopback_host( (string) ( $parts['host'] ?? '' ) ) ) {
		return $url;
	}

	$host = strtolower( trim( (string) $parts['host'], '[]' ) );
	if ( 'localhost' === $host && 'http' === $scheme ) {
		return $url;
	}

	$port     = isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '';
	$path     = (string) ( $parts['path'] ?? '' );
	$query    = isset( $parts['query'] ) ? '?' . (string) $parts['query'] : '';
	$fragment = isset( $parts['fragment'] ) ? '#' . (string) $parts['fragment'] : '';

	return 'http://localhost' . $port . $path . $query . $fragment;
}

private static function browser_plugin_uses_loopback_url( string $url ): bool {
	$parts = wp_parse_url( $url );
	$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
	return is_array( $parts ) && in_array( $scheme, array( 'http', 'https' ), true ) && self::is_loopback_host( (string) ( $parts['host'] ?? '' ) );
}

private static function browser_download_remote_plugin( string $url, string $zip_path, string $slug ): true|WP_Error {
	$request = function_exists( 'wp_safe_remote_get' ) ? 'wp_safe_remote_get' : ( function_exists( 'wp_remote_get' ) ? 'wp_remote_get' : null );
	if ( null === $request ) {
		return new WP_Error( 'wp_codebox_browser_plugin_http_missing', 'Browser runtime plugin remote packaging requires the WordPress HTTP API.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$response = $request(
		$url,
		array(
			'timeout'     => 60,
			'redirection' => 5,
		)
	);
	if ( is_wp_error( $response ) ) {
		return $response;
	}

	$code = function_exists( 'wp_remote_retrieve_response_code' ) ? (int) wp_remote_retrieve_response_code( $response ) : (int) ( $response['response']['code'] ?? 0 );
	if ( $code < 200 || $code >= 300 ) {
		return new WP_Error( 'wp_codebox_browser_plugin_download_failed', 'Could not download browser runtime plugin package.', array( 'status' => 502, 'slug' => $slug, 'http_status' => $code ) );
	}

	$body = function_exists( 'wp_remote_retrieve_body' ) ? (string) wp_remote_retrieve_body( $response ) : (string) ( $response['body'] ?? '' );
	if ( '' === $body ) {
		return new WP_Error( 'wp_codebox_browser_plugin_download_empty', 'Downloaded browser runtime plugin package is empty.', array( 'status' => 502, 'slug' => $slug ) );
	}

	if ( false === file_put_contents( $zip_path, $body ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_package_write_failed', 'Could not write browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	return true;
}

private static function browser_component_source_fingerprint( string $source_path ): string {
	$source_path = rtrim( $source_path, '/\\' );
	$entries     = array();
	$iterator    = self::browser_component_file_iterator( $source_path );
	foreach ( $iterator as $file ) {
		if ( ! $file instanceof SplFileInfo || ! $file->isFile() ) {
			continue;
		}

		$path = $file->getPathname();
		$relative = ltrim( substr( $path, strlen( $source_path ) ), '/\\' );
		if ( '' === $relative ) {
			continue;
		}

		$entries[] = str_replace( DIRECTORY_SEPARATOR, '/', $relative ) . ':' . $file->getSize() . ':' . $file->getMTime();
	}

	sort( $entries, SORT_STRING );

	return hash( 'sha256', implode( "\n", $entries ) );
}

private static function write_browser_plugin_zip( string $slug, string $source_path, string $zip_path ): true|WP_Error {
	return self::write_browser_component_zip( $slug, $source_path, $zip_path, 'plugin' );
}

private static function write_browser_component_zip( string $slug, string $source_path, string $zip_path, string $kind ): true|WP_Error {
	$zip = new ZipArchive();
	if ( true !== $zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE ) ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_zip_open_failed', 'Could not open browser runtime package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	$source_path = rtrim( $source_path, '/\\' );
	$iterator    = self::browser_component_file_iterator( $source_path );

	foreach ( $iterator as $file ) {
		if ( ! $file instanceof SplFileInfo || ! $file->isFile() ) {
			continue;
		}

		$path = $file->getPathname();
		$relative = ltrim( substr( $path, strlen( $source_path ) ), '/\\' );
		if ( '' === $relative ) {
			continue;
		}

		$zip->addFile( $path, $slug . '/' . str_replace( DIRECTORY_SEPARATOR, '/', $relative ) );
	}

	if ( true !== $zip->close() ) {
		return new WP_Error( 'wp_codebox_browser_' . $kind . '_zip_close_failed', 'Could not close browser runtime package.', array( 'status' => 500, 'slug' => $slug ) );
	}

	return true;
}

/** @return array{url:string,origin:string,host:string}|WP_Error */
private static function browser_remote_theme_package_url( string $url, int $index ): array|WP_Error {
	$source = self::browser_theme_url( $url, $index );
	if ( is_wp_error( $source ) ) {
		return $source;
	}

	return $source;
}

private static function stable_json( mixed $value ): string {
	if ( ! is_array( $value ) ) {
		return (string) json_encode( $value, JSON_UNESCAPED_SLASHES );
	}

	if ( array_is_list( $value ) ) {
		return '[' . implode( ',', array_map( static fn( mixed $item ): string => self::stable_json( $item ), $value ) ) . ']';
	}

	ksort( $value, SORT_STRING );
	$parts = array();
	foreach ( $value as $key => $item ) {
		$parts[] = json_encode( (string) $key, JSON_UNESCAPED_SLASHES ) . ':' . self::stable_json( $item );
	}

	return '{' . implode( ',', $parts ) . '}';
}

private static function browser_component_file_iterator( string $source_path ): RecursiveIteratorIterator {
	return new RecursiveIteratorIterator(
		new RecursiveCallbackFilterIterator(
			new RecursiveDirectoryIterator( $source_path, FilesystemIterator::SKIP_DOTS ),
			static fn( SplFileInfo $file ): bool => ! in_array( $file->getFilename(), array( '.git', '.svn', '.hg', 'node_modules' ), true )
		)
	);
}

/** @param array<int,array<string,mixed>> $plugins Browser plugin specs. @return array<int,array<string,mixed>> */
private static function dedupe_browser_plugins( array $plugins ): array {
	$deduped = array();
	$slugs   = array();
	foreach ( $plugins as $plugin ) {
		$slug = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
		if ( '' !== $slug ) {
			if ( isset( $slugs[ $slug ] ) ) {
				continue;
			}

			$slugs[ $slug ] = true;
		}

		$deduped[] = $plugin;
	}

	return $deduped;
}

/** @param array<int,mixed> $plugins Plugin dependency specs. @return array<int,array<string,mixed>>|WP_Error */
private static function normalize_browser_plugins( array $plugins, string $field ): array|WP_Error {
	$normalized = array();

	foreach ( $plugins as $index => $plugin ) {
		if ( ! is_array( $plugin ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_invalid', 'Each browser plugin must be an object.', array( 'status' => 400, 'field' => $field, 'index' => $index ) );
		}

		$url      = trim( (string) ( $plugin['url'] ?? '' ) );
		$slug     = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
		$resource = (string) ( $plugin['resource'] ?? 'url' );
		if ( ! in_array( $resource, array( 'url', 'git:directory' ), true ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_resource_invalid', 'Browser plugin resource is not supported.', array( 'status' => 400, 'index' => $index, 'resource' => $resource ) );
		}

		$source = ! empty( $plugin['local_package'] ) ? self::browser_local_plugin_url( $url, $index ) : self::browser_plugin_url( $url, $index );
		if ( is_wp_error( $source ) ) {
			return $source;
		}

		$sha256 = strtolower( trim( (string) ( $plugin['sha256'] ?? '' ) ) );
		if ( '' !== $sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $sha256 ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_sha256_invalid', 'Browser plugin sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index ) );
		}

		$provenance = is_array( $plugin['provenance'] ?? null ) ? $plugin['provenance'] : array();

		$normalized[] = array(
			'url'              => $source['url'],
			'slug'             => $slug,
			'resource'         => $resource,
			'activate'         => ! array_key_exists( 'activate', $plugin ) || (bool) $plugin['activate'],
			'local_package'    => ! empty( $plugin['local_package'] ),
			'local_package_fetch_url' => ! empty( $plugin['local_package'] ) ? trim( (string) ( $plugin['local_package_fetch_url'] ?? $plugin['url'] ?? '' ) ) : '',
			'sha256'           => $sha256,
			'ref'              => sanitize_text_field( (string) ( $plugin['ref'] ?? '' ) ),
			'refType'          => sanitize_key( (string) ( $plugin['refType'] ?? '' ) ),
			'path'             => 'git:directory' === $resource ? ltrim( str_replace( '\\', '/', (string) ( $plugin['path'] ?? '' ) ), '/' ) : '',
			'targetFolderName' => sanitize_key( (string) ( $plugin['targetFolderName'] ?? ( ! empty( $plugin['local_package'] ) ? $slug : '' ) ) ),
			'provenance'       => array_filter(
				array(
					'schema' => 'wp-codebox/browser-plugin-provenance/v1',
					'url'    => $source['url'],
					'origin' => $source['origin'],
					'host'   => $source['host'],
					'source' => is_string( $provenance['source'] ?? null ) ? $provenance['source'] : '',
					'sha256' => $sha256,
				)
			),
		);
	}

	return $normalized;
}

/** @return array{url:string,origin:string,host:string}|WP_Error */
private static function browser_local_plugin_url( string $url, int $index ): array|WP_Error {
	if ( str_starts_with( $url, 'data:application/zip;base64,' ) ) {
		return array(
			'url'    => $url,
			'origin' => 'data:',
			'host'   => 'data',
		);
	}

	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_url_invalid', 'Browser plugin URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
	}

	return array(
		'url'    => $url,
		'origin' => self::url_origin( $parts ),
		'host'   => strtolower( (string) $parts['host'] ),
	);
}

/** @return array{url:string,origin:string,host:string}|WP_Error */
private static function browser_remote_plugin_package_url( string $url, int $index ): array|WP_Error {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_url_invalid', 'Browser plugin URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
	}

	$scheme = strtolower( (string) $parts['scheme'] );
	$host   = strtolower( (string) $parts['host'] );
	$allow_http = self::is_loopback_host( $host );
	if ( 'https' !== $scheme && ! ( $allow_http && 'http' === $scheme ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_url_insecure', 'Browser plugin URL must use https://.', array( 'status' => 400, 'index' => $index ) );
	}

	$default_hosts = self::is_loopback_host( $host ) ? array( 'downloads.wordpress.org', 'github.com', 'codeload.github.com', $host ) : array( 'downloads.wordpress.org', 'github.com', 'codeload.github.com' );
	$allowed_hosts = array_map( 'strtolower', self::string_list( apply_filters( 'wp_codebox_browser_runtime_plugin_package_allowed_hosts', $default_hosts, $url, $index ) ) );
	if ( ! in_array( $host, $allowed_hosts, true ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_host_not_allowed', 'Browser plugin URL host is not allowed.', array( 'status' => 400, 'index' => $index, 'host' => $host ) );
	}

	return array( 'url' => $url, 'origin' => self::url_origin( $parts ), 'host' => $host );
}

/** @return array{url:string,origin:string,host:string}|WP_Error */
private static function browser_plugin_url( string $url, int $index ): array|WP_Error {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_url_invalid', 'Browser plugin URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
	}

	$scheme     = strtolower( (string) $parts['scheme'] );
	$host       = strtolower( (string) $parts['host'] );
	$allow_http = self::is_loopback_host( $host ) || (bool) apply_filters( 'wp_codebox_browser_plugin_allow_http', false, $url, $index );
	if ( 'https' !== $scheme && ! ( $allow_http && 'http' === $scheme ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_url_insecure', 'Browser plugin URL must use https://.', array( 'status' => 400, 'index' => $index ) );
	}

	$origin        = self::url_origin( $parts );
	$default_hosts = self::is_loopback_host( $host ) ? array( 'downloads.wordpress.org', 'github.com', 'codeload.github.com', $host ) : array( 'downloads.wordpress.org', 'github.com', 'codeload.github.com' );
	$allowed_hosts = array_map( 'strtolower', self::string_list( apply_filters( 'wp_codebox_browser_plugin_allowed_hosts', $default_hosts, $url, $index ) ) );
	if ( ! in_array( $host, $allowed_hosts, true ) ) {
		return new WP_Error( 'wp_codebox_browser_plugin_host_not_allowed', 'Browser plugin URL host is not allowed.', array( 'status' => 400, 'index' => $index, 'host' => $host ) );
	}

	return array( 'url' => $url, 'origin' => $origin, 'host' => $host );
}

/** @return array{url:string,origin:string,host:string}|WP_Error */
private static function browser_theme_url( string $url, int $index ): array|WP_Error {
	$parts = wp_parse_url( $url );
	if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
		return new WP_Error( 'wp_codebox_browser_theme_url_invalid', 'Browser theme URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
	}

	$scheme     = strtolower( (string) $parts['scheme'] );
	$host       = strtolower( (string) $parts['host'] );
	$allow_http = self::is_loopback_host( $host );
	if ( 'https' !== $scheme && ! ( $allow_http && 'http' === $scheme ) ) {
		return new WP_Error( 'wp_codebox_browser_theme_url_insecure', 'Browser theme URL must use https://.', array( 'status' => 400, 'index' => $index ) );
	}

	$origin        = self::url_origin( $parts );
	$default_hosts = self::is_loopback_host( $host ) ? array( 'downloads.wordpress.org', $host ) : array( 'downloads.wordpress.org' );
	$allowed_hosts = array_map( 'strtolower', self::string_list( apply_filters( 'wp_codebox_browser_theme_allowed_hosts', $default_hosts, $url, $index ) ) );
	if ( ! in_array( $host, $allowed_hosts, true ) ) {
		return new WP_Error( 'wp_codebox_browser_theme_host_not_allowed', 'Browser theme URL host is not allowed.', array( 'status' => 400, 'index' => $index, 'host' => $host ) );
	}

	return array( 'url' => $url, 'origin' => $origin, 'host' => $host );
}

/** @param array<string,string|int> $parts URL parts. */
private static function url_origin( array $parts ): string {
	$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
	$host   = strtolower( (string) ( $parts['host'] ?? '' ) );
	$port   = isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '';
	return $scheme . '://' . $host . $port;
}

private static function is_loopback_host( string $host ): bool {
	$host = strtolower( trim( $host, '[]' ) );
	return 'localhost' === $host || '127.0.0.1' === $host || '::1' === $host;
}

/** @return string[] */
private static function normalized_origins( mixed $origins ): array {
	$normalized = array();
	foreach ( self::string_list( $origins ) as $origin ) {
		$parts = wp_parse_url( $origin );
		if ( is_array( $parts ) && ! empty( $parts['scheme'] ) && ! empty( $parts['host'] ) ) {
			$normalized[] = self::url_origin( $parts );
		}
	}
	return array_values( array_unique( $normalized ) );
}

private static function safe_key( string $value ): string {
	if ( function_exists( 'sanitize_key' ) ) {
		return sanitize_key( $value );
	}

	return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $value ) ?? '' );
}

}
