<?php
/**
 * WP Codebox CLI binary resolver.
 *
 * Single owner of WP Codebox CLI binary selection. An explicit
 * `wp_codebox_bin` option or filter always wins. Otherwise the bundled CLI
 * under `vendor/wp-codebox-cli` is used only when its `package.json` version
 * matches the plugin version and its packaged platform/arch (recorded in the
 * release packaging provenance) matches the host. Everything else falls back
 * to `wp-codebox` on PATH.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Cli_Resolver {

	public const OPTION_NAME = 'wp_codebox_bin';
	public const FILTER_NAME = 'wp_codebox_bin';
	public const PATH_BINARY = 'wp-codebox';

	public const REASON_BUNDLED_CLI_SELECTED          = 'bundled_cli_selected';
	public const REASON_BUNDLED_CLI_VERSION_MISMATCH  = 'bundled_cli_version_mismatch';
	public const REASON_BUNDLED_CLI_PLATFORM_MISMATCH = 'bundled_cli_platform_mismatch';
	public const REASON_BUNDLED_CLI_MISSING           = 'bundled_cli_missing';
	public const REASON_CONFIGURED                    = 'configured';

	/**
	 * Resolve the WP Codebox CLI binary plus the decision diagnostics.
	 *
	 * @return array{bin:string,reason:string,bundled_bin:string,bundled_version:?string,bundled_platform:?string,bundled_arch:?string,host_platform:string,host_arch:string,configured_bin:string}
	 */
	public static function resolve(): array {
		$configured = self::configured_bin();
		$bundled    = self::bundled_decision();

		if ( '' !== $configured ) {
			$bin    = $configured;
			$reason = self::REASON_CONFIGURED;
		} elseif ( $bundled['selected'] ) {
			$bin    = $bundled['bin'];
			$reason = self::REASON_BUNDLED_CLI_SELECTED;
		} else {
			$bin    = self::PATH_BINARY;
			$reason = $bundled['reason'];
		}

		return array(
			'bin'              => $bin,
			'reason'           => $reason,
			'bundled_bin'      => $bundled['bin'],
			'bundled_version'  => $bundled['version'],
			'bundled_platform' => $bundled['platform'],
			'bundled_arch'     => $bundled['arch'],
			'host_platform'    => self::host_platform(),
			'host_arch'        => self::host_arch(),
			'configured_bin'   => $configured,
		);
	}

	/**
	 * Readiness payload for `resolve-runtime-requirements` surfacing.
	 *
	 * @return array<string,mixed> Same shape as resolve().
	 */
	public static function readiness(): array {
		return self::resolve();
	}

	public static function default_bin(): string {
		return self::resolve()['bin'];
	}

	/**
	 * The bundled Node.js runtime path, only when the bundled CLI decision
	 * selected the bundle for this host. A bundled node binary built for a
	 * different platform can never run here, so a rejected bundle yields ''.
	 */
	public static function bundled_node_binary(): string {
		if ( ! self::bundled_decision()['selected'] ) {
			return '';
		}

		$path = self::bundle_root() . 'vendor/node/bin/node';

		return is_file( $path ) && is_executable( $path ) ? $path : '';
	}

	public static function is_bundled_cli( string $bin ): bool {
		$bundled = self::bundled_bin_path();

		return '' !== $bundled && $bin === $bundled;
	}

	/**
	 * @return array{selected:bool,reason:string,bin:string,version:?string,platform:?string,arch:?string}
	 */
	private static function bundled_decision(): array {
		$bin = self::bundled_bin_path();
		$decision = array(
			'selected' => false,
			'reason'   => self::REASON_BUNDLED_CLI_MISSING,
			'bin'      => $bin,
			'version'  => null,
			'platform' => null,
			'arch'     => null,
		);

		if ( '' === $bin || ! is_file( $bin ) ) {
			return $decision;
		}

		$manifest = self::read_json_object( self::bundle_root() . 'package.json' );
		$version  = is_string( $manifest['version'] ?? null ) ? (string) $manifest['version'] : '';
		$decision['version'] = '' !== $version ? $version : null;

		if ( '' === $version || ! self::plugin_version_matches( $version ) ) {
			$decision['reason'] = self::REASON_BUNDLED_CLI_VERSION_MISMATCH;

			return $decision;
		}

		$provenance = self::read_json_object( self::bundle_root() . 'browser-provenance.json' );
		$platform   = is_string( $provenance['platform'] ?? null ) ? self::normalize_platform( (string) $provenance['platform'] ) : '';
		$arch       = is_string( $provenance['arch'] ?? null ) ? self::normalize_arch( (string) $provenance['arch'] ) : '';
		$decision['platform'] = '' !== $platform ? $platform : null;
		$decision['arch']     = '' !== $arch ? $arch : null;

		if ( '' === $platform || '' === $arch || $platform !== self::host_platform() || $arch !== self::host_arch() ) {
			$decision['reason'] = self::REASON_BUNDLED_CLI_PLATFORM_MISMATCH;

			return $decision;
		}

		$decision['selected'] = true;
		$decision['reason']   = self::REASON_BUNDLED_CLI_SELECTED;

		return $decision;
	}

	private static function plugin_version_matches( string $bundled_version ): bool {
		return defined( 'WP_CODEBOX_PLUGIN_VERSION' ) && is_string( WP_CODEBOX_PLUGIN_VERSION ) && $bundled_version === WP_CODEBOX_PLUGIN_VERSION;
	}

	private static function configured_bin(): string {
		$configured = self::config_option( self::OPTION_NAME, '' );

		if ( function_exists( 'apply_filters' ) ) {
			$configured = apply_filters( self::FILTER_NAME, $configured );
		}

		return is_string( $configured ) ? trim( $configured ) : '';
	}

	private static function config_option( string $name, mixed $default ): mixed {
		if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
			return get_site_option( $name, $default );
		}

		if ( function_exists( 'get_option' ) ) {
			return get_option( $name, $default );
		}

		return $default;
	}

	private static function bundle_root(): string {
		if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) || ! is_string( WP_CODEBOX_PLUGIN_PATH ) ) {
			return '';
		}

		return rtrim( WP_CODEBOX_PLUGIN_PATH, '/\\' ) . '/vendor/wp-codebox-cli/';
	}

	private static function bundled_bin_path(): string {
		$root = self::bundle_root();

		return '' !== $root ? $root . 'bin/wp-codebox' : '';
	}

	/** @return array<string,mixed> */
	private static function read_json_object( string $path ): array {
		if ( ! is_file( $path ) ) {
			return array();
		}

		$contents = file_get_contents( $path );
		if ( ! is_string( $contents ) ) {
			return array();
		}

		$decoded = json_decode( $contents, true );

		return is_array( $decoded ) && ! array_is_list( $decoded ) ? $decoded : array();
	}

	/**
	 * Host platform in release packaging terms (PHP_OS_FAMILY mapped to the
	 * platform names scripts/lib/release-target.ts writes into the bundle
	 * provenance: linux, macos, windows).
	 */
	private static function host_platform(): string {
		return match ( PHP_OS_FAMILY ) {
			'Darwin' => 'macos',
			'Linux' => 'linux',
			'Windows' => 'windows',
			'BSD' => 'freebsd',
			'Solaris' => 'sunos',
			default => strtolower( PHP_OS_FAMILY ),
		};
	}

	/**
	 * Host arch in node terms (php_uname('m') mapped to the arch names the
	 * release packaging records: x64, arm64).
	 */
	private static function host_arch(): string {
		return self::normalize_arch( php_uname( 'm' ) );
	}

	/** Normalize packaged or host platform spellings to release packaging names. */
	private static function normalize_platform( string $platform ): string {
		$platform = strtolower( trim( $platform ) );

		return match ( $platform ) {
			'darwin' => 'macos',
			'win32' => 'windows',
			default => $platform,
		};
	}

	/** Normalize packaged or host arch spellings to node arch names. */
	private static function normalize_arch( string $arch ): string {
		$arch = strtolower( trim( $arch ) );

		return match ( $arch ) {
			'x86_64', 'amd64' => 'x64',
			'aarch64' => 'arm64',
			'i386', 'i686' => 'ia32',
			default => $arch,
		};
	}
}
