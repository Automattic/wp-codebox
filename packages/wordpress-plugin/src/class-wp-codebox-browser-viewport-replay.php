<?php
/**
 * Deterministic host-side viewport replay.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Browser_Viewport_Replay {

	private const MAX_ARCHIVE_BYTES = 26214400;
	private const MAX_SCREENSHOT_BYTES = 5242880;

	/** @var array<string,callable> */
	private array $callbacks;

	/** @param array<string,callable> $callbacks Test seams. */
	public function __construct( array $callbacks = array() ) {
		$this->callbacks = $callbacks;
	}

	/** @param array<string,mixed> $input Replay request. @return array<string,mixed>|WP_Error */
	public function run( array $input ): array|WP_Error {
		$request = $this->normalize_request( $input );
		if ( is_wp_error( $request ) ) {
			return $request;
		}

		$directory = $this->create_temp_directory();
		if ( is_wp_error( $directory ) ) {
			return $directory;
		}

		try {
			$archive_path = $directory . DIRECTORY_SEPARATOR . 'site.zip';
			$recipe_path  = $directory . DIRECTORY_SEPARATOR . 'recipe.json';
			$artifacts    = $directory . DIRECTORY_SEPARATOR . 'artifacts';
			if ( false === file_put_contents( $archive_path, $request['archive'] ) ) {
				return new WP_Error( 'wp_codebox_viewport_replay_archive_write_failed', 'Could not stage the browser preview archive.', array( 'status' => 500 ) );
			}

			$recipe = $this->recipe( $request );
			if ( false === file_put_contents( $recipe_path, wp_json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT ) ) ) {
				return new WP_Error( 'wp_codebox_viewport_replay_recipe_write_failed', 'Could not stage the viewport replay recipe.', array( 'status' => 500 ) );
			}

			$result = $this->run_recipe( $recipe_path, $artifacts, $directory, (int) $request['timeout_ms'] );
			if ( is_wp_error( $result ) ) {
				return $result;
			}
			if ( empty( $result['success'] ) ) {
				return new WP_Error(
					'wp_codebox_viewport_replay_failed',
					'WP Codebox viewport replay failed.',
					array(
						'status'    => 500,
						'exit_code' => (int) ( $result['exit_code'] ?? -1 ),
						'output'    => $this->bounded_output( (string) ( $result['stderr'] ?? $result['stdout'] ?? '' ) ),
					)
				);
			}

			$screenshot_path = $this->screenshot_path( $artifacts );
			$screenshot      = $screenshot_path ? file_get_contents( $screenshot_path ) : false;
			if ( ! is_string( $screenshot ) || strlen( $screenshot ) < 8 || strlen( $screenshot ) > self::MAX_SCREENSHOT_BYTES || "\x89PNG\r\n\x1a\n" !== substr( $screenshot, 0, 8 ) ) {
				return new WP_Error( 'wp_codebox_viewport_replay_screenshot_invalid', 'Viewport replay did not produce a bounded PNG screenshot.', array( 'status' => 500 ) );
			}

			return array(
				'success'    => true,
				'schema'     => 'wp-codebox/browser-viewport-replay-result/v1',
				'status'     => 'captured',
				'png_base64' => base64_encode( $screenshot ),
				'diagnostics' => array(
					array(
						'code'     => 'viewport_replay_captured',
						'message'  => 'Viewport screenshot captured through deterministic Playground replay.',
						'severity' => 'info',
						'phase'    => 'viewport_capture',
					),
				),
			);
		} finally {
			$this->remove_directory( $directory );
		}
	}

	/** @param array<string,mixed> $input @return array<string,mixed>|WP_Error */
	private function normalize_request( array $input ): array|WP_Error {
		$route = (string) ( $input['route'] ?? '' );
		if ( ! str_starts_with( $route, '/' ) || str_starts_with( $route, '//' ) ) {
			return new WP_Error( 'wp_codebox_viewport_replay_route_invalid', 'Viewport replay requires a safe absolute route.', array( 'status' => 400 ) );
		}
		$viewport = is_array( $input['viewport'] ?? null ) ? $input['viewport'] : array();
		$width    = (int) ( $viewport['width'] ?? 0 );
		$height   = (int) ( $viewport['height'] ?? 0 );
		if ( $width < 1 || $height < 1 || $width > 10000 || $height > 10000 ) {
			return new WP_Error( 'wp_codebox_viewport_replay_viewport_invalid', 'Viewport replay requires width and height between 1 and 10000.', array( 'status' => 400 ) );
		}
		$timeout_ms = (int) ( $input['timeout_ms'] ?? 30000 );
		if ( $timeout_ms < 5000 || $timeout_ms > 180000 ) {
			return new WP_Error( 'wp_codebox_viewport_replay_timeout_invalid', 'Viewport replay timeout_ms must be between 5000 and 180000.', array( 'status' => 400 ) );
		}
		$encoded = (string) ( $input['archive_base64'] ?? '' );
		$archive = base64_decode( $encoded, true );
		if ( ! is_string( $archive ) || strlen( $archive ) > self::MAX_ARCHIVE_BYTES ) {
			return new WP_Error( 'wp_codebox_viewport_replay_archive_invalid', 'Viewport replay requires a bounded Playground ZIP archive.', array( 'status' => 400 ) );
		}
		$archive_error = WP_Codebox_Zip_Archive_Validator::validate( $archive );
		if ( is_wp_error( $archive_error ) ) {
			return new WP_Error( 'wp_codebox_viewport_replay_archive_invalid', 'Viewport replay requires a bounded and safe Playground ZIP archive.', array( 'status' => 400 ) );
		}

		return array(
			'route'       => $route,
			'viewport'    => array( 'width' => $width, 'height' => $height ),
			'timeout_ms'  => $timeout_ms,
			'archive'     => $archive,
			'wp_version'  => $this->version( $input['wp_version'] ?? 'latest', 'latest' ),
			'php_version' => $this->version( $input['php_version'] ?? '8.3', '8.3' ),
		);
	}

	/** @param array<string,mixed> $request @return array<string,mixed> */
	private function recipe( array $request ): array {
		$timeout = $this->browser_action_timeout_ms( (int) $request['timeout_ms'] ) . 'ms';
		return array(
			'schema'  => 'wp-codebox/workspace-recipe/v1',
			'runtime' => array(
				'backend'    => 'wordpress-playground',
				'name'       => 'browser-viewport-replay',
				'wp'         => $request['wp_version'],
				'phpVersion' => $request['php_version'],
				'blueprint'  => array(
					'landingPage' => $request['route'],
					'steps'       => array(
						array(
							'step'              => 'importWordPressFiles',
							'wordPressFilesZip' => array( 'resource' => 'vfs', 'path' => '/wordpress/wp-codebox-viewport-site.zip' ),
						),
					),
				),
			),
			'inputs' => array(
				'mounts' => array(
					array(
						'type'             => 'file',
						'source'           => './site.zip',
						'target'           => '/wordpress/wp-codebox-viewport-site.zip',
						'mode'             => 'readonly',
						'captureArtifacts' => false,
						'phase'            => 'pre-install',
					),
				),
			),
			'workflow' => array(
				'steps' => array(
					array(
						'command' => 'wordpress.browser-actions',
						'args'    => array(
							'url=' . $request['route'],
							'viewport=' . $request['viewport']['width'] . 'x' . $request['viewport']['height'],
							'capture=screenshot',
							'timeout=' . $timeout,
							'step-timeout=' . $timeout,
						),
					),
				),
			),
			'artifacts' => array( 'directory' => './artifacts' ),
		);
	}

	/** @return array<string,mixed>|WP_Error */
	private function run_recipe( string $recipe, string $artifacts, string $cwd, int $timeout_ms ): array|WP_Error {
		// Reserve a fixed margin so the CLI is stopped before the caller's budget expires.
		$lifecycle_timeout_ms = $timeout_ms - 1000;
		$command              = $this->command( array( 'recipe-run', '--recipe', $recipe, '--artifacts', $artifacts, '--json', '--timeout', $lifecycle_timeout_ms . 'ms' ) );
		if ( is_wp_error( $command ) ) {
			return $command;
		}
		$config = array(
			'command'           => $command,
			'cwd'               => $cwd,
			'allowed_cwd_roots' => array( $cwd ),
			'timeout_seconds'   => max( 1, (int) ceil( $lifecycle_timeout_ms / 1000 ) ),
			'max_output_bytes'  => 1048576,
		);
		return isset( $this->callbacks['command_runner'] )
			? ( $this->callbacks['command_runner'] )( $config )
			: WP_Codebox_Managed_Host_Command::run( $config );
	}

	private function browser_action_timeout_ms( int $budget_ms ): int {
		return max( 1000, $budget_ms - 3000 );
	}

	/** @param string[] $args @return string[]|WP_Error */
	private function command( array $args ): array|WP_Error {
		$bundled = defined( 'WP_CODEBOX_PLUGIN_PATH' ) ? WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox' : '';
		$bin     = is_file( $bundled ) ? $bundled : 'wp-codebox';
		$bin     = function_exists( 'apply_filters' ) ? (string) apply_filters( 'wp_codebox_bin', $bin ) : $bin;
		if ( preg_match( '/\.m?js$/', $bin ) ) {
			$node = trim( (string) ( getenv( 'WP_CODEBOX_NODE_BIN' ) ?: 'node' ) );
			return WP_Codebox_Managed_Host_Command::command( $node, array_merge( array( $bin ), $args ) );
		}
		return WP_Codebox_Managed_Host_Command::command( $bin, $args );
	}

	private function create_temp_directory(): string|WP_Error {
		$base = rtrim( sys_get_temp_dir(), DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox-viewport-' . bin2hex( random_bytes( 8 ) );
		if ( ! mkdir( $base, 0700, true ) ) {
			return new WP_Error( 'wp_codebox_viewport_replay_temp_failed', 'Could not create a private viewport replay directory.', array( 'status' => 500 ) );
		}
		return $base;
	}

	private function remove_directory( string $directory ): void {
		if ( ! is_dir( $directory ) ) {
			return;
		}
		$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $directory, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST );
		foreach ( $iterator as $entry ) {
			$entry->isDir() ? rmdir( $entry->getPathname() ) : unlink( $entry->getPathname() );
		}
		rmdir( $directory );
	}

	private function screenshot_path( string $artifacts ): ?string {
		if ( ! is_dir( $artifacts ) ) {
			return null;
		}

		$matches  = array();
		$suffix   = DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'browser' . DIRECTORY_SEPARATOR . 'screenshot.png';
		$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $artifacts, FilesystemIterator::SKIP_DOTS ) );
		foreach ( $iterator as $entry ) {
			if ( $entry->isFile() && str_ends_with( $entry->getPathname(), $suffix ) ) {
				$matches[] = $entry->getPathname();
			}
		}

		return 1 === count( $matches ) ? $matches[0] : null;
	}

	private function version( mixed $value, string $default ): string {
		$value = trim( (string) $value );
		return preg_match( '/^(?:latest|trunk|beta|nightly|next|\d+\.\d+(?:\.\d+)?(?:-(?:beta\d+|RC\d+))?)$/i', $value ) ? $value : $default;
	}

	private function bounded_output( string $output ): string {
		return strlen( $output ) <= 4000 ? $output : substr( $output, 0, 4000 );
	}
}
