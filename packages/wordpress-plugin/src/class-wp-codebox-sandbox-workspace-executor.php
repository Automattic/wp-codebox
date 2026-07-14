<?php
/**
 * Sandbox-workspace executor adapter for the Agents API tool contract.
 *
 * Registers a git-less, in-sandbox file/code tool surface against the same
 * Agents API `WP_Agent_Tool_Executor` contract that Data Machine Code's blessed
 * (host, git-tracked) workspace executor satisfies. Where the DMC executor
 * resolves `<repo>`/`<repo>@<branch-slug>` handles to git worktrees and applies
 * patches through `git apply`, this executor operates on a single bounded
 * working directory: plain working-directory-relative reads, lists, greps,
 * writes, edits, and a self-contained unified-diff applier. No repo handle, no
 * worktree/primary safety gates, no git.
 *
 * Worker agent bundles running inside a browser/Playground sandbox call the same
 * tool names (`workspace_read`, `workspace_ls`, `workspace_grep`,
 * `workspace_write`, `workspace_edit`, `workspace_apply_patch`); when the run is
 * placed on the sandbox executor target those calls resolve here instead of the
 * host git workspace.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

/**
 * Projects git-less sandbox workspace file tools into Agents API runtime tools.
 */
final class WP_Codebox_Sandbox_Workspace_Executor {

	public const TARGET_ID   = 'wp-codebox/sandbox-workspace';
	public const SOURCE_SLUG = 'client';

	private const MAX_READ_BYTES   = 1048576;   // 1 MB default read cap.
	private const MAX_WRITE_BYTES  = 5242880;   // 5 MB write cap.
	private const MAX_GREP_RESULTS = 500;
	private const MAX_CONTEXT_LINES = 10;

	/**
	 * Tool declarations keyed by Agents API client tool name.
	 *
	 * @var array<string,array<string,mixed>>
	 */
	private const TOOL_MAP = array(
		'client/workspace_read'         => array(
			'base'         => 'workspace_read',
			'capability'   => 'workspace.files.read',
			'description'  => 'Read a text file from the sandbox working directory.',
			'side_effects' => array(),
			'parameters'   => array(
				'type'       => 'object',
				'required'   => array( 'path' ),
				'properties' => array(
					'path'     => array(
						'type'        => 'string',
						'description' => 'Relative file path within the sandbox working root.',
					),
					'max_size' => array(
						'type'        => 'integer',
						'description' => 'Maximum file size in bytes (default 1 MB).',
					),
					'offset'   => array(
						'type'        => 'integer',
						'description' => 'Line number to start reading from (1-indexed).',
					),
					'limit'    => array(
						'type'        => 'integer',
						'description' => 'Maximum number of lines to return.',
					),
				),
			),
		),
		'client/workspace_ls'           => array(
			'base'         => 'workspace_ls',
			'capability'   => 'workspace.files.read',
			'description'  => 'List directory contents within the sandbox working directory.',
			'side_effects' => array(),
			'parameters'   => array(
				'type'       => 'object',
				'properties' => array(
					'path' => array(
						'type'        => 'string',
						'description' => 'Relative directory path within the sandbox working root (omit for root).',
					),
				),
			),
		),
		'client/workspace_grep'         => array(
			'base'         => 'workspace_grep',
			'capability'   => 'workspace.files.read',
			'description'  => 'Search text files within the sandbox working directory using a regular expression.',
			'side_effects' => array(),
			'parameters'   => array(
				'type'       => 'object',
				'required'   => array( 'pattern' ),
				'properties' => array(
					'pattern'       => array(
						'type'        => 'string',
						'description' => 'Regular expression pattern to search for.',
					),
					'path'          => array(
						'type'        => 'string',
						'description' => 'Optional relative file or directory path to search within.',
					),
					'include'       => array(
						'type'        => 'string',
						'description' => 'Optional glob pattern to limit matching file paths.',
					),
					'max_results'   => array(
						'type'        => 'integer',
						'description' => 'Maximum number of matches to return (default 100, max 500).',
					),
					'context_lines' => array(
						'type'        => 'integer',
						'description' => 'Number of surrounding lines to include for each match (default 0, max 10).',
					),
				),
			),
		),
		'client/workspace_write'        => array(
			'base'         => 'workspace_write',
			'capability'   => 'workspace.files.write',
			'description'  => 'Create or overwrite a file in the sandbox working directory.',
			'side_effects' => array( 'filesystem.write' ),
			'parameters'   => array(
				'type'       => 'object',
				'required'   => array( 'path', 'content' ),
				'properties' => array(
					'path'    => array(
						'type'        => 'string',
						'description' => 'Relative file path within the sandbox working root.',
					),
					'content' => array(
						'type'        => 'string',
						'description' => 'File content to write.',
					),
				),
			),
		),
		'client/workspace_edit'         => array(
			'base'         => 'workspace_edit',
			'capability'   => 'workspace.files.write',
			'description'  => 'Find-and-replace text in a sandbox working directory file.',
			'side_effects' => array( 'filesystem.write' ),
			'parameters'   => array(
				'type'       => 'object',
				'required'   => array( 'path' ),
				'properties' => array(
					'path'        => array(
						'type'        => 'string',
						'description' => 'Relative file path within the sandbox working root.',
					),
					'old_string'  => array(
						'type'        => 'string',
						'description' => 'Text to find.',
					),
					'new_string'  => array(
						'type'        => 'string',
						'description' => 'Replacement text.',
					),
					'search'      => array(
						'type'        => 'string',
						'description' => 'Alias for old_string.',
					),
					'replace'     => array(
						'type'        => 'string',
						'description' => 'Alias for new_string.',
					),
					'old'         => array(
						'type'        => 'string',
						'description' => 'Alias for old_string.',
					),
					'new'         => array(
						'type'        => 'string',
						'description' => 'Alias for new_string.',
					),
					'replace_all' => array(
						'type'        => 'boolean',
						'description' => 'Replace all occurrences (default false).',
					),
				),
			),
		),
		'client/workspace_apply_patch'  => array(
			'base'         => 'workspace_apply_patch',
			'capability'   => 'workspace.files.write',
			'description'  => 'Apply a unified diff to files within the sandbox working directory. Git-less: hunks are applied by context match and fail closed on mismatch.',
			'side_effects' => array( 'filesystem.write' ),
			'parameters'   => array(
				'type'       => 'object',
				'required'   => array( 'patch' ),
				'properties' => array(
					'patch' => array(
						'type'        => 'string',
						'description' => 'Unified diff content to apply.',
					),
				),
			),
		),
		'client/workspace_show'         => array(
			'base'         => 'workspace_show',
			'capability'   => 'workspace.files.read',
			'description'  => 'Show bounded metadata for the sandbox workspace without exposing host paths.',
			'side_effects' => array(),
			'parameters'   => array( 'type' => 'object', 'properties' => array() ),
		),
		'client/workspace_git_status'   => array(
			'base'         => 'workspace_git_status',
			'capability'   => 'workspace.files.read',
			'description'  => 'Compare the sandbox workspace to its captured baseline without invoking git or a shell.',
			'side_effects' => array(),
			'parameters'   => array( 'type' => 'object', 'properties' => array() ),
		),
		'client/workspace_git_diff'     => array(
			'base'         => 'workspace_git_diff',
			'capability'   => 'workspace.files.read',
			'description'  => 'Return a bounded baseline-versus-current unified diff without invoking git or a shell.',
			'side_effects' => array(),
			'parameters'   => array( 'type' => 'object', 'properties' => array() ),
		),
	);

	private static bool $registered = false;

	/**
	 * Register optional Agents API hooks when the substrate is loaded.
	 */
	public static function register(): bool {
		if ( self::$registered ) {
			return true;
		}

		if ( ! function_exists( 'add_filter' ) || ! self::substrate_exists() ) {
			return false;
		}

		add_filter( 'agents_api_tool_executors', array( self::class, 'register_tool_executor' ), 20, 2 );

		self::$registered = true;
		return true;
	}

	/**
	 * Whether Agents API has the generic tool execution substrate loaded.
	 */
	public static function substrate_exists(): bool {
		return interface_exists( 'AgentsAPI\\AI\\Tools\\WP_Agent_Tool_Executor' )
			&& class_exists( 'AgentsAPI\\AI\\Tools\\WP_Agent_Tool_Source_Registry' );
	}

	/**
	 * Register the tool-call executor adapter for registry-based dispatch.
	 *
	 * @param array<string,mixed> $executors Existing executors.
	 * @param array<string,mixed> $context Runtime context.
	 * @return array<string,mixed>
	 */
	public static function register_tool_executor( array $executors, array $context = array() ): array {
		$executors[ self::TARGET_ID ] = self::executor_for_context( $context );

		return $executors;
	}

	/** @param array<string,mixed> $trusted_context */
	public static function executor_for_context( array $trusted_context ): \AgentsAPI\AI\Tools\WP_Agent_Tool_Executor {
		return new class( new self(), $trusted_context ) implements \AgentsAPI\AI\Tools\WP_Agent_Tool_Executor {
			/** @param array<string,mixed> $trusted_context */
			public function __construct( private WP_Codebox_Sandbox_Workspace_Executor $adapter, private array $trusted_context ) {}

			/** @param array<string,mixed> $tool_call @param array<string,mixed> $tool_definition @param array<string,mixed> $context @return array<string,mixed> */
			public function executeWP_Agent_Tool_Call( array $tool_call, array $tool_definition, array $context = array() ): array {
				return $this->adapter->executeWP_Agent_Tool_Call( $tool_call, $tool_definition, array_replace( $context, $this->trusted_context ) );
			}
		};
	}

	/**
	 * Canonical Agents API runtime tool declarations for the git-less sandbox surface.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	public static function tool_declarations(): array {
		$tools = array();
		foreach ( self::TOOL_MAP as $config ) {
			$declaration = array(
				'name'        => $config['base'],
				'source'      => self::SOURCE_SLUG,
				'description' => $config['description'],
				'parameters'  => $config['parameters'],
				'executor'    => 'client',
				'scope'       => 'run',
				'runtime'     => array(
					'executor_target'      => self::TARGET_ID,
					'capability'           => $config['capability'],
					'side_effects'         => $config['side_effects'],
					'side_effect_boundary' => 'wp-codebox-sandbox',
				),
			);
			$tools[ $config['base'] ] = $declaration;
		}

		return $tools;
	}

	/**
	 * Return declarations only for canonical workspace tools enabled by the selected agent.
	 *
	 * @param array<string,mixed> $agent_config
	 * @param array<string,mixed> $context Trusted invocation-local context.
	 * @return array<string,array<string,mixed>>
	 */
	public static function tool_declarations_for_enabled_tools( array $agent_config, array $context = array() ): array {
		unset( $context );
		$enabled = is_array( $agent_config['enabled_tools'] ?? null ) ? $agent_config['enabled_tools'] : array();
		$all     = self::tool_declarations();
		$tools   = array();
		foreach ( $enabled as $name ) {
			$name = is_string( $name ) ? trim( $name ) : '';
			if ( '' !== $name && isset( $all[ $name ] ) ) {
				$tools[ $name ] = $all[ $name ];
			}
		}

		return $tools;
	}

	/**
	 * Target metadata for generic Agents API executor discovery.
	 *
	 * @return array<string,mixed>
	 */
	public static function target_metadata(): array {
		return array(
			'id'                    => self::TARGET_ID,
			'label'                 => 'WP Codebox sandbox workspace',
			'description'           => 'Git-less, in-sandbox file/code tool surface bounded to the sandbox working directory. No repo handle, no worktree/primary policy, no git.',
			'resource_class'        => 'workspace',
			'kind'                  => 'sandbox-workspace',
			'required_capabilities' => array_values(
				array_unique(
					array_map(
						static fn( array $config ): string => (string) $config['capability'],
						self::TOOL_MAP
					)
				)
			),
			'side_effect_boundary'  => 'wp-codebox-sandbox',
			'side_effects'          => array( 'filesystem.write' ),
		);
	}

	/**
	 * Execute a prepared Agents API tool call against the sandbox working root.
	 *
	 * @param array<string,mixed> $tool_call Tool call.
	 * @param array<string,mixed> $tool_definition Tool declaration.
	 * @param array<string,mixed> $context Runtime context.
	 * @return array<string,mixed>
	 */
	public function executeWP_Agent_Tool_Call( array $tool_call, array $tool_definition, array $context = array() ): array {
		$started_at = microtime( true );

		$tool_name = (string) ( $tool_call['tool_name'] ?? $tool_definition['name'] ?? '' );
		$config    = self::resolve_config( $tool_name );
		if ( null === $config ) {
			return self::error_result( $tool_name, 'Sandbox workspace executor does not provide this tool.', 'unsupported_tool', null, $started_at );
		}

		$parameters = is_array( $tool_call['parameters'] ?? null ) ? $tool_call['parameters'] : array();

		$root = self::resolve_workspace_root( $context, $parameters );
		if ( is_string( $root ) && '' === $root ) {
			return self::error_result( $tool_name, 'Sandbox working root is not configured or does not exist.', 'workspace_root_unavailable', $config, $started_at );
		}

		// Policy is supplied by the host's explicit workflow mapping, never inferred
		// from arbitrary ambient tool arguments.
		$parameters['_wp_codebox_writable_paths'] = self::writable_paths( $context );
		$parameters['_wp_codebox_baseline_root']  = self::baseline_root( $context );
		$result = self::dispatch( $config['base'], $root, $parameters );
		if ( is_array( $result ) && false === ( $result['success'] ?? true ) ) {
			return self::error_result(
				$tool_name,
				(string) ( $result['error'] ?? 'Sandbox workspace tool failed.' ),
				(string) ( $result['error_type'] ?? 'sandbox_workspace_error' ),
				$config,
				$started_at
			);
		}

		return array(
			'success'           => true,
			'tool_name'         => $tool_name,
			'result'            => $result,
			'runtime'           => self::runtime_metadata( $config ),
			'execution_metrics' => self::execution_metrics( $tool_name, $config, $parameters, $result, $started_at, null ),
		);
	}

	/**
	 * Resolve a tool config by Agents API name, tolerating an absent source prefix.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function resolve_config( string $tool_name ): ?array {
		if ( isset( self::TOOL_MAP[ $tool_name ] ) ) {
			return self::TOOL_MAP[ $tool_name ];
		}

		$base = str_contains( $tool_name, '/' ) ? substr( $tool_name, strrpos( $tool_name, '/' ) + 1 ) : $tool_name;
		foreach ( self::TOOL_MAP as $config ) {
			if ( $config['base'] === $base ) {
				return $config;
			}
		}

		return null;
	}

	/**
	 * Dispatch a base tool name to its git-less implementation.
	 *
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function dispatch( string $base, string $root, array $parameters ): array {
		switch ( $base ) {
			case 'workspace_read':
				return self::read_file( $root, $parameters );
			case 'workspace_ls':
				return self::list_directory( $root, $parameters );
			case 'workspace_grep':
				return self::grep_files( $root, $parameters );
			case 'workspace_write':
				return self::write_file( $root, $parameters );
			case 'workspace_edit':
				return self::edit_file( $root, $parameters );
			case 'workspace_apply_patch':
				return self::apply_patch( $root, $parameters );
			case 'workspace_show':
				return self::workspace_show( $root, $parameters );
			case 'workspace_git_status':
				return self::workspace_status( $root, $parameters );
			case 'workspace_git_diff':
				return self::workspace_diff( $root, $parameters );
		}

		return self::tool_error( 'unsupported_tool', 'Unsupported sandbox workspace tool.' );
	}

	// -----------------------------------------------------------------
	// Tool implementations (git-less, working-directory-relative).
	// -----------------------------------------------------------------

	/**
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function read_file( string $root, array $parameters ): array {
		$relative = self::relative_param( $parameters['path'] ?? '' );
		if ( is_array( $relative ) ) {
			return $relative;
		}

		$path = self::contained_path( $root, $relative, true );
		if ( is_array( $path ) ) {
			return $path;
		}

		if ( ! is_file( $path ) || ! is_readable( $path ) ) {
			return self::tool_error( 'file_not_readable', 'Sandbox workspace file is not readable.' );
		}

		$max_size = isset( $parameters['max_size'] ) ? max( 1, (int) $parameters['max_size'] ) : self::MAX_READ_BYTES;
		$size     = (int) filesize( $path );
		if ( $size > $max_size ) {
			return self::tool_error( 'file_too_large', sprintf( 'File is %d bytes, exceeding the %d byte limit.', $size, $max_size ) );
		}

		$content = self::read_raw( $path );
		if ( null === $content ) {
			return self::tool_error( 'file_read_failed', 'Sandbox workspace file could not be read.' );
		}

		$offset_in  = isset( $parameters['offset'] ) ? (int) $parameters['offset'] : 0;
		$limit_in   = isset( $parameters['limit'] ) ? (int) $parameters['limit'] : 0;
		$start_line = $offset_in > 0 ? $offset_in : 1;

		if ( $offset_in > 0 || $limit_in > 0 ) {
			$lines = explode( "\n", $content );
			$slice = array_slice( $lines, $start_line - 1, $limit_in > 0 ? $limit_in : null );
			$out   = implode( "\n", $slice );

			return array(
				'success'    => true,
				'path'       => $relative,
				'content'    => $out,
				'size'       => $size,
				'lines_read' => count( $slice ),
				'offset'     => $start_line,
			);
		}

		return array(
			'success'    => true,
			'path'       => $relative,
			'content'    => $content,
			'size'       => $size,
			'lines_read' => '' === $content ? 0 : substr_count( $content, "\n" ) + 1,
			'offset'     => 1,
		);
	}

	/**
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function list_directory( string $root, array $parameters ): array {
		$raw      = isset( $parameters['path'] ) ? (string) $parameters['path'] : '';
		$relative = '' === trim( $raw ) ? '' : self::relative_param( $raw );
		if ( is_array( $relative ) ) {
			return $relative;
		}

		$path = '' === $relative ? $root : self::contained_path( $root, $relative, true );
		if ( is_array( $path ) ) {
			return $path;
		}

		if ( ! is_dir( $path ) ) {
			return self::tool_error( 'not_a_directory', 'Sandbox workspace path is not a directory.' );
		}

		$entries = array();
		$names    = scandir( $path );
		foreach ( false === $names ? array() : $names as $name ) {
			if ( '.' === $name || '..' === $name ) {
				continue;
			}
			$full = $path . DIRECTORY_SEPARATOR . $name;
			$entries[] = array(
				'name' => $name,
				'type' => is_dir( $full ) ? 'directory' : 'file',
				'size' => is_file( $full ) ? (int) filesize( $full ) : 0,
			);
		}

		usort(
			$entries,
			static function ( array $a, array $b ): int {
				if ( $a['type'] !== $b['type'] ) {
					return 'directory' === $a['type'] ? -1 : 1;
				}
				return strcmp( $a['name'], $b['name'] );
			}
		);

		return array(
			'success' => true,
			'path'    => $relative,
			'entries' => $entries,
		);
	}

	/**
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function grep_files( string $root, array $parameters ): array {
		$pattern = isset( $parameters['pattern'] ) ? (string) $parameters['pattern'] : '';
		if ( '' === $pattern ) {
			return self::tool_error( 'pattern_required', 'Grep requires a pattern.' );
		}

		$regex = '~' . str_replace( '~', '\~', $pattern ) . '~';
		if ( false === @preg_match( $regex, '' ) ) {
			return self::tool_error( 'invalid_pattern', 'Grep pattern is not a valid regular expression.' );
		}

		$raw      = isset( $parameters['path'] ) ? (string) $parameters['path'] : '';
		$relative = '' === trim( $raw ) ? '' : self::relative_param( $raw );
		if ( is_array( $relative ) ) {
			return $relative;
		}

		$base = '' === $relative ? $root : self::contained_path( $root, $relative, true );
		if ( is_array( $base ) ) {
			return $base;
		}

		$include       = isset( $parameters['include'] ) ? (string) $parameters['include'] : '';
		$max_results   = isset( $parameters['max_results'] ) ? max( 1, min( self::MAX_GREP_RESULTS, (int) $parameters['max_results'] ) ) : 100;
		$context_lines = isset( $parameters['context_lines'] ) ? max( 0, min( self::MAX_CONTEXT_LINES, (int) $parameters['context_lines'] ) ) : 0;

		$files = is_dir( $base ) ? self::iterate_files( $base ) : array( $base );

		$matches   = array();
		$truncated = false;
		foreach ( $files as $file ) {
			$relative_file = self::relative_to_root( $root, $file );
			if ( '' !== $include && ! self::glob_match( $include, $relative_file ) ) {
				continue;
			}
			if ( (int) filesize( $file ) > self::MAX_READ_BYTES ) {
				continue;
			}
			$content = self::read_raw( $file );
			if ( null === $content || self::looks_binary( $content ) ) {
				continue;
			}

			$lines = explode( "\n", $content );
			foreach ( $lines as $index => $line ) {
				if ( 1 !== @preg_match( $regex, $line ) ) {
					continue;
				}
				if ( count( $matches ) >= $max_results ) {
					$truncated = true;
					break 2;
				}

				$match = array(
					'path' => $relative_file,
					'line' => $index + 1,
					'text' => $line,
				);
				if ( $context_lines > 0 ) {
					$match['context'] = array_values(
						array_slice(
							$lines,
							max( 0, $index - $context_lines ),
							$context_lines * 2 + 1
						)
					);
				}
				$matches[] = $match;
			}
		}

		return array(
			'success'   => true,
			'path'      => $relative,
			'pattern'   => $pattern,
			'count'     => count( $matches ),
			'truncated' => $truncated,
			'matches'   => $matches,
		);
	}

	/**
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function write_file( string $root, array $parameters ): array {
		$relative = self::relative_param( $parameters['path'] ?? '' );
		if ( is_array( $relative ) ) {
			return $relative;
		}

		$content = is_scalar( $parameters['content'] ?? null ) ? (string) $parameters['content'] : '';
		if ( strlen( $content ) > self::MAX_WRITE_BYTES ) {
			return self::tool_error( 'content_too_large', sprintf( 'Content is %d bytes, exceeding the %d byte limit.', strlen( $content ), self::MAX_WRITE_BYTES ) );
		}
		if ( self::looks_binary( $content ) ) {
			return self::tool_error( 'binary_content', 'Sandbox workspace writes accept text content only.' );
		}
		$writable = self::writable_path( $relative, $parameters );
		if ( is_array( $writable ) ) {
			return $writable;
		}

		$path = self::contained_path( $root, $relative, false );
		if ( is_array( $path ) ) {
			return $path;
		}

		$created = ! file_exists( $path );
		$parent  = dirname( $path );
		if ( ! is_dir( $parent ) && ! self::mkdir_p( $parent ) ) {
			return self::tool_error( 'directory_create_failed', 'Sandbox workspace directory could not be created.' );
		}
		if ( ! self::is_inside( $parent, $root ) ) {
			return self::tool_error( 'path_escape', 'Sandbox workspace write path escapes the working root.' );
		}

		if ( false === self::write_raw( $path, $content ) ) {
			return self::tool_error( 'file_write_failed', 'Sandbox workspace file could not be written.' );
		}

		return array(
			'success' => true,
			'path'    => $relative,
			'size'    => strlen( $content ),
			'created' => $created,
		);
	}

	/**
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function edit_file( string $root, array $parameters ): array {
		$relative = self::relative_param( $parameters['path'] ?? '' );
		if ( is_array( $relative ) ) {
			return $relative;
		}
		$writable = self::writable_path( $relative, $parameters );
		if ( is_array( $writable ) ) {
			return $writable;
		}

		$old = self::first_string( $parameters, array( 'old_string', 'search', 'old' ) );
		$new = self::first_string( $parameters, array( 'new_string', 'replace', 'new' ) );
		if ( '' === $old ) {
			return self::tool_error( 'old_string_required', 'Edit requires old_string (or search/old) to find.' );
		}

		$path = self::contained_path( $root, $relative, true );
		if ( is_array( $path ) ) {
			return $path;
		}
		if ( ! is_file( $path ) || ! is_readable( $path ) ) {
			return self::tool_error( 'file_not_readable', 'Sandbox workspace file is not readable.' );
		}

		$content = self::read_raw( $path );
		if ( null === $content ) {
			return self::tool_error( 'file_read_failed', 'Sandbox workspace file could not be read.' );
		}
		if ( self::looks_binary( $content ) ) {
			return self::tool_error( 'binary_content', 'Sandbox workspace edits accept text files only.' );
		}

		$occurrences = substr_count( $content, $old );
		if ( 0 === $occurrences ) {
			return self::tool_error( 'no_match', 'Edit found no occurrence of old_string.' );
		}

		$replace_all = ! empty( $parameters['replace_all'] );
		if ( ! $replace_all && $occurrences > 1 ) {
			return self::tool_error( 'ambiguous_match', sprintf( 'old_string matched %d times; pass replace_all or a more specific string.', $occurrences ) );
		}

		$updated      = $replace_all ? str_replace( $old, $new, $content, $count ) : self::replace_first( $content, $old, $new );
		$replacements = $replace_all ? (int) $count : 1;

		if ( strlen( $updated ) > self::MAX_WRITE_BYTES ) {
			return self::tool_error( 'content_too_large', 'Edited content exceeds the write size limit.' );
		}
		if ( self::looks_binary( $updated ) ) {
			return self::tool_error( 'binary_content', 'Sandbox workspace edits accept text content only.' );
		}
		if ( false === self::write_raw( $path, $updated ) ) {
			return self::tool_error( 'file_write_failed', 'Sandbox workspace file could not be written.' );
		}

		return array(
			'success'      => true,
			'path'         => $relative,
			'replacements' => $replacements,
		);
	}

	/**
	 * Apply a unified diff without git. Hunks are matched by context and fail
	 * closed on mismatch; supports modify, create (`/dev/null` source) and
	 * delete (`/dev/null` target).
	 *
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return array<string,mixed>
	 */
	private static function apply_patch( string $root, array $parameters ): array {
		$patch = is_scalar( $parameters['patch'] ?? null ) ? (string) $parameters['patch'] : '';
		if ( '' === trim( $patch ) ) {
			return self::tool_error( 'patch_required', 'Apply-patch requires a unified diff.' );
		}
		if ( strlen( $patch ) > self::MAX_WRITE_BYTES || self::looks_binary( $patch ) ) {
			return self::tool_error( 'invalid_patch', 'Patch must be bounded text content.' );
		}

		$files = self::parse_unified_diff( $patch );
		if ( is_array( $files ) && isset( $files['error'] ) ) {
			return self::tool_error( 'invalid_patch', (string) $files['error'] );
		}
		if ( empty( $files ) ) {
			return self::tool_error( 'invalid_patch', 'No file changes were found in the patch.' );
		}

		// Validate + stage every file before writing anything (fail closed).
		$staged = array();
		foreach ( $files as $file ) {
			$relative = self::relative_param( $file['target'] === null ? $file['source'] : $file['target'] );
			if ( is_array( $relative ) ) {
				return $relative;
			}
			$writable = self::writable_path( $relative, $parameters );
			if ( is_array( $writable ) ) {
				return $writable;
			}

			// Containment is enforced here; existence is checked per-op below.
			$path = self::contained_path( $root, $relative, false );
			if ( is_array( $path ) ) {
				return $path;
			}

			if ( null === $file['target'] ) {
				if ( ! is_file( $path ) ) {
					return self::tool_error( 'patch_target_missing', sprintf( 'Cannot delete missing file: %s', $relative ) );
				}
				$staged[] = array( 'op' => 'delete', 'path' => $path, 'relative' => $relative );
				continue;
			}

			$original = '';
			if ( null !== $file['source'] ) {
				if ( ! is_file( $path ) ) {
					return self::tool_error( 'patch_target_missing', sprintf( 'Patch source file does not exist: %s', $relative ) );
				}
				$read = self::read_raw( $path );
				if ( null === $read ) {
					return self::tool_error( 'file_read_failed', sprintf( 'Patch source file could not be read: %s', $relative ) );
				}
				$original = $read;
			} elseif ( is_file( $path ) ) {
				return self::tool_error( 'patch_target_exists', sprintf( 'Patch creates a file that already exists: %s', $relative ) );
			}

			$applied = self::apply_hunks( $original, $file['hunks'] );
			if ( isset( $applied['error'] ) ) {
				return self::tool_error( 'patch_context_mismatch', sprintf( '%s in %s', $applied['error'], $relative ) );
			}

			if ( strlen( $applied['content'] ) > self::MAX_WRITE_BYTES ) {
				return self::tool_error( 'content_too_large', sprintf( 'Patched content for %s exceeds the write size limit.', $relative ) );
			}

			$staged[] = array( 'op' => 'write', 'path' => $path, 'relative' => $relative, 'content' => $applied['content'] );
		}

		$changed = array();
		foreach ( $staged as $entry ) {
			if ( 'delete' === $entry['op'] ) {
				if ( ! self::unlink_path( $entry['path'] ) ) {
					return self::tool_error( 'file_delete_failed', sprintf( 'Could not delete %s.', $entry['relative'] ) );
				}
				$changed[] = $entry['relative'];
				continue;
			}

			$parent = dirname( $entry['path'] );
			if ( ! is_dir( $parent ) && ! self::mkdir_p( $parent ) ) {
				return self::tool_error( 'directory_create_failed', sprintf( 'Could not create directory for %s.', $entry['relative'] ) );
			}
			if ( false === self::write_raw( $entry['path'], $entry['content'] ) ) {
				return self::tool_error( 'file_write_failed', sprintf( 'Could not write %s.', $entry['relative'] ) );
			}
			$changed[] = $entry['relative'];
		}

		return array(
			'success'       => true,
			'path'          => '',
			'changed_files' => array_values( array_unique( $changed ) ),
			'status'        => 'applied',
		);
	}

	// -----------------------------------------------------------------
	// Unified-diff parsing + application (git-less).
	// -----------------------------------------------------------------

	/**
	 * Parse a unified diff into per-file hunk sets.
	 *
	 * @return array<int,array<string,mixed>>|array{error:string}
	 */
	private static function parse_unified_diff( string $patch ) {
		$lines = explode( "\n", str_replace( "\r\n", "\n", $patch ) );
		$files = array();
		$count = count( $lines );
		$i     = 0;

		while ( $i < $count ) {
			$line = $lines[ $i ];

			if ( str_starts_with( $line, '--- ' ) ) {
				$source = self::diff_path( substr( $line, 4 ) );
				if ( $i + 1 >= $count || ! str_starts_with( $lines[ $i + 1 ], '+++ ' ) ) {
					return array( 'error' => 'Malformed file header: missing +++ line.' );
				}
				$target = self::diff_path( substr( $lines[ $i + 1 ], 4 ) );
				$i     += 2;

				$hunks = array();
				while ( $i < $count && str_starts_with( $lines[ $i ], '@@' ) ) {
					$hunk = self::parse_hunk_header( $lines[ $i ] );
					if ( null === $hunk ) {
						return array( 'error' => 'Malformed hunk header.' );
					}
					++$i;
					while ( $i < $count ) {
						$hline = $lines[ $i ];
						if ( str_starts_with( $hline, '@@' ) || str_starts_with( $hline, '--- ' ) || str_starts_with( $hline, 'diff --git ' ) ) {
							break;
						}
						if ( '' === $hline ) {
							// Well-formed diffs prefix blank context lines with a
							// space (" "); a zero-length line is the trailing
							// artifact of the final newline, so end the hunk body.
							break;
						}
						$marker = $hline[0];
						if ( '\\' === $marker ) { // "\ No newline at end of file".
							$hunk['no_newline'] = true;
							++$i;
							continue;
						}
						if ( ' ' !== $marker && '+' !== $marker && '-' !== $marker ) {
							break;
						}
						$hunk['lines'][] = array( $marker, substr( $hline, 1 ) );
						++$i;
					}
					$hunks[] = $hunk;
				}

				$files[] = array(
					'source' => $source,
					'target' => $target,
					'hunks'  => $hunks,
				);
				continue;
			}

			++$i;
		}

		return $files;
	}

	/**
	 * Normalize a diff path token. Returns null for /dev/null, else strips a/ b/.
	 */
	private static function diff_path( string $token ): ?string {
		$token = trim( $token );
		// Drop a trailing tab-delimited timestamp if present.
		$tab = strpos( $token, "\t" );
		if ( false !== $tab ) {
			$token = substr( $token, 0, $tab );
		}
		$token = trim( $token );
		if ( '/dev/null' === $token ) {
			return null;
		}
		if ( str_starts_with( $token, 'a/' ) || str_starts_with( $token, 'b/' ) ) {
			$token = substr( $token, 2 );
		}

		return $token;
	}

	/**
	 * @return array<string,mixed>|null
	 */
	private static function parse_hunk_header( string $line ): ?array {
		if ( 1 !== preg_match( '/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/', $line, $m ) ) {
			return null;
		}

		return array(
			'old_start'  => (int) $m[1],
			'old_count'  => isset( $m[2] ) && '' !== $m[2] ? (int) $m[2] : 1,
			'new_start'  => (int) $m[3],
			'new_count'  => isset( $m[4] ) && '' !== $m[4] ? (int) $m[4] : 1,
			'lines'      => array(),
		);
	}

	/**
	 * Apply parsed hunks to original content. Fail closed on context mismatch.
	 *
	 * @param array<int,array<string,mixed>> $hunks Parsed hunks.
	 * @return array{content:string}|array{error:string}
	 */
	private static function apply_hunks( string $original, array $hunks ): array {
		$had_trailing_newline = '' === $original || str_ends_with( $original, "\n" );
		$lines                = '' === $original ? array() : explode( "\n", $original );
		if ( $had_trailing_newline && '' !== $original ) {
			array_pop( $lines ); // Drop the empty element after the final newline.
		}

		$result = array();
		$cursor = 0; // Index into $lines already consumed/copied.

		foreach ( $hunks as $hunk ) {
			$target = max( 0, (int) $hunk['old_start'] - 1 );

			// Copy unchanged lines up to the hunk start.
			while ( $cursor < $target && $cursor < count( $lines ) ) {
				$result[] = $lines[ $cursor ];
				++$cursor;
			}

			foreach ( $hunk['lines'] as $pair ) {
				list( $marker, $text ) = $pair;
				if ( ' ' === $marker ) {
					if ( ! isset( $lines[ $cursor ] ) || $lines[ $cursor ] !== $text ) {
						return array( 'error' => sprintf( 'Context mismatch at line %d', $cursor + 1 ) );
					}
					$result[] = $lines[ $cursor ];
					++$cursor;
				} elseif ( '-' === $marker ) {
					if ( ! isset( $lines[ $cursor ] ) || $lines[ $cursor ] !== $text ) {
						return array( 'error' => sprintf( 'Removed-line mismatch at line %d', $cursor + 1 ) );
					}
					++$cursor;
				} elseif ( '+' === $marker ) {
					$result[] = $text;
				}
			}
		}

		// Copy any remaining unchanged lines.
		while ( $cursor < count( $lines ) ) {
			$result[] = $lines[ $cursor ];
			++$cursor;
		}

		$content = implode( "\n", $result );
		if ( $had_trailing_newline && '' !== $content ) {
			$content .= "\n";
		}

		return array( 'content' => $content );
	}

	/** @param array<string,mixed> $parameters @return array<string,mixed> */
	private static function workspace_show( string $root, array $parameters ): array {
		$files = self::iterate_files( $root );
		return array(
			'success'        => true,
			'root'           => '/workspace',
			'file_count'     => count( $files ),
			'writable_paths' => self::writable_paths_from_parameters( $parameters ),
			'baseline'       => '' !== self::baseline_from_parameters( $parameters ) ? 'available' : 'unavailable',
		);
	}

	/** @param array<string,mixed> $parameters @return array<string,mixed> */
	private static function workspace_status( string $root, array $parameters ): array {
		$baseline = self::baseline_from_parameters( $parameters );
		if ( '' === $baseline ) {
			return self::tool_error( 'baseline_unavailable', 'Sandbox workspace baseline is unavailable.' );
		}
		$current = self::workspace_file_map( $root );
		$before  = self::workspace_file_map( $baseline );
		$changed = array();
		foreach ( array_unique( array_merge( array_keys( $before ), array_keys( $current ) ) ) as $path ) {
			if ( ! isset( $before[ $path ] ) || ! isset( $current[ $path ] ) || ! hash_equals( $before[ $path ], $current[ $path ] ) ) {
				$changed[] = $path;
			}
		}
		sort( $changed );
		return array( 'success' => true, 'changed' => ! empty( $changed ), 'files' => $changed, 'dirty' => count( $changed ), 'baseline' => 'filesystem' );
	}

	/** @param array<string,mixed> $parameters @return array<string,mixed> */
	private static function workspace_diff( string $root, array $parameters ): array {
		$status = self::workspace_status( $root, $parameters );
		if ( empty( $status['success'] ) ) {
			return $status;
		}
		$baseline = self::baseline_from_parameters( $parameters );
		$patch = '';
		foreach ( $status['files'] as $relative ) {
			$before = is_file( $baseline . '/' . $relative ) ? self::read_raw( $baseline . '/' . $relative ) : '';
			$after  = is_file( $root . '/' . $relative ) ? self::read_raw( $root . '/' . $relative ) : '';
			if ( null === $before || null === $after || self::looks_binary( $before ) || self::looks_binary( $after ) ) {
				return self::tool_error( 'binary_content', 'Workspace diff cannot represent binary content.' );
			}
			$from = is_file( $baseline . '/' . $relative ) ? 'a/' . $relative : '/dev/null';
			$to   = is_file( $root . '/' . $relative ) ? 'b/' . $relative : '/dev/null';
			$patch .= "--- {$from}\n+++ {$to}\n@@ -1," . substr_count( $before, "\n" ) . " +1," . substr_count( $after, "\n" ) . " @@\n";
			foreach ( explode( "\n", rtrim( $before, "\n" ) ) as $line ) { if ( '' !== $line || '' !== $before ) { $patch .= '-' . $line . "\n"; } }
			foreach ( explode( "\n", rtrim( $after, "\n" ) ) as $line ) { if ( '' !== $line || '' !== $after ) { $patch .= '+' . $line . "\n"; } }
		}
		return array( 'success' => true, 'changed' => ! empty( $status['files'] ), 'files' => $status['files'], 'diff' => $patch, 'baseline' => 'filesystem' );
	}

	/** @return array<string,string> */
	private static function workspace_file_map( string $root ): array {
		$map = array();
		foreach ( self::iterate_files( $root ) as $file ) {
			$relative = self::relative_to_root( $root, $file );
			$content = self::read_raw( $file );
			if ( null !== $content ) { $map[ $relative ] = hash( 'sha256', $content ); }
		}
		return $map;
	}

	// -----------------------------------------------------------------
	// Workspace root + path containment.
	// -----------------------------------------------------------------

	/**
	 * Resolve the bounded sandbox working root.
	 *
	 * The host supplies this through the invocation-local executor context.
	 *
	 * @param array<string,mixed> $context Runtime context.
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @return string Realpath of the working root, or '' when unavailable.
	 */
	private static function resolve_workspace_root( array $context, array $parameters ): string {
		unset( $parameters );
		$candidate = $context['workspace_root'] ?? '';
		$real      = is_string( $candidate ) && '' !== trim( $candidate ) ? realpath( $candidate ) : false;
		return false !== $real && is_dir( $real ) ? $real : '';
	}

	/** @return array<int,string> */
	private static function writable_paths( array $context ): array {
		$policy = is_array( $context['workflow_policy'] ?? null ) ? $context['workflow_policy'] : ( is_array( $context['runner_workspace_policy'] ?? null ) ? $context['runner_workspace_policy'] : array() );
		$paths  = $policy['writable_paths'] ?? $context['writable_paths'] ?? array();
		if ( is_string( $paths ) ) { $paths = preg_split( '/\s*,\s*/', trim( $paths ) ) ?: array(); }
		$paths = array_values( array_filter( array_map( static fn( $path ): string => is_scalar( $path ) ? trim( (string) $path ) : '', is_array( $paths ) ? $paths : array() ) ) );
		return is_array( $paths ) ? array_values( array_filter( array_map( static fn( $path ): string => is_scalar( $path ) ? trim( (string) $path ) : '', $paths ) ) ) : array();
	}

	private static function baseline_root( array $context ): string {
		$candidate = $context['workspace_baseline_root'] ?? ( is_array( $context['workspace'] ?? null ) ? ( $context['workspace']['baseline_root'] ?? '' ) : '' );
		$candidate = is_string( $candidate ) ? $candidate : '';
		$real = '' !== $candidate ? realpath( $candidate ) : false;
		return false !== $real && is_dir( $real ) ? $real : '';
	}

	/** @param array<string,mixed> $parameters @return array<int,string> */
	private static function writable_paths_from_parameters( array $parameters ): array {
		return is_array( $parameters['_wp_codebox_writable_paths'] ?? null ) ? $parameters['_wp_codebox_writable_paths'] : array();
	}

	/** @param array<string,mixed> $parameters */
	private static function baseline_from_parameters( array $parameters ): string {
		return is_string( $parameters['_wp_codebox_baseline_root'] ?? null ) ? $parameters['_wp_codebox_baseline_root'] : '';
	}

	/** @param array<string,mixed> $parameters @return true|array<string,mixed> */
	private static function writable_path( string $relative, array $parameters ) {
		$parts = explode( '/', $relative );
		if ( in_array( '.git', $parts, true ) || in_array( '.codebox', $parts, true ) || str_starts_with( basename( $relative ), '.' ) ) {
			return self::tool_error( 'control_path_denied', 'Sandbox workspace mutations cannot target control paths.' );
		}
		$patterns = self::writable_paths_from_parameters( $parameters );
		if ( empty( $patterns ) ) {
			return self::tool_error( 'writable_path_denied', 'No writable_paths policy permits this mutation.' );
		}
		foreach ( $patterns as $pattern ) {
			$pattern = ltrim( str_replace( '\\', '/', $pattern ), '/' );
			if ( $relative === $pattern || fnmatch( $pattern, $relative, FNM_PATHNAME ) || ( str_ends_with( $pattern, '/**' ) && str_starts_with( $relative . '/', substr( $pattern, 0, -2 ) ) ) ) {
				return true;
			}
		}
		return self::tool_error( 'writable_path_denied', 'Sandbox workspace mutation is outside workflow writable_paths.' );
	}

	/**
	 * Validate and resolve a relative path contained within the working root.
	 *
	 * @return string Resolved absolute path, or array error envelope.
	 * @phpstan-return string|array<string,mixed>
	 */
	private static function contained_path( string $root, string $relative, bool $must_exist ) {
		$candidate = $root . DIRECTORY_SEPARATOR . $relative;
		$real      = realpath( $candidate );
		if ( false !== $real ) {
			return self::is_inside( $real, $root ) || $real === $root ? $real : self::tool_error( 'path_escape', 'Sandbox workspace path escapes the working root.' );
		}

		if ( $must_exist ) {
			return self::tool_error( 'path_not_found', 'Sandbox workspace path does not exist.' );
		}

		$parent      = dirname( $candidate );
		$parent_real = realpath( $parent );
		if ( false === $parent_real ) {
			// Parent dir does not exist yet; containment is guaranteed by the
			// rejected `..` segments in relative_param plus the realpath'd root.
			return $candidate;
		}

		return self::is_inside( $parent_real, $root ) || $parent_real === $root ? $candidate : self::tool_error( 'path_escape', 'Sandbox workspace path escapes the working root.' );
	}

	/**
	 * Normalize and validate a relative path parameter.
	 *
	 * @return string Clean relative path, or array error envelope.
	 * @phpstan-return string|array<string,mixed>
	 */
	private static function relative_param( mixed $value ) {
		$path = is_scalar( $value ) ? str_replace( '\\', '/', trim( (string) $value ) ) : '';
		if ( '' === $path ) {
			return self::tool_error( 'path_required', 'A relative path is required.' );
		}
		if ( str_contains( $path, "\0" ) ) {
			return self::tool_error( 'invalid_path', 'Path contains an invalid character.' );
		}
		if ( str_starts_with( $path, '/' ) || 1 === preg_match( '#^[A-Za-z]:(?:$|/)#', $path ) ) {
			return self::tool_error( 'invalid_path', 'Path must be relative to the sandbox working root.' );
		}

		$parts = array_filter( explode( '/', $path ), static fn( string $part ): bool => '' !== $part && '.' !== $part );
		foreach ( $parts as $part ) {
			if ( '..' === $part ) {
				return self::tool_error( 'path_escape', 'Path cannot contain parent-directory traversal.' );
			}
		}

		return implode( '/', $parts );
	}

	private static function is_inside( string $path, string $root ): bool {
		$root = rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR;
		$path = rtrim( $path, DIRECTORY_SEPARATOR ) . ( is_dir( $path ) ? DIRECTORY_SEPARATOR : '' );

		return str_starts_with( $path, $root );
	}

	/**
	 * @param string $root Working root.
	 * @return string Relative path of $file beneath $root.
	 */
	private static function relative_to_root( string $root, string $file ): string {
		$root_prefix = rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR;
		if ( str_starts_with( $file, $root_prefix ) ) {
			return str_replace( '\\', '/', substr( $file, strlen( $root_prefix ) ) );
		}

		return str_replace( '\\', '/', $file );
	}

	/**
	 * @return array<int,string> Absolute file paths beneath $dir.
	 */
	private static function iterate_files( string $dir ): array {
		$files    = array();
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::LEAVES_ONLY
		);
		foreach ( $iterator as $info ) {
			if ( $info->isFile() ) {
				$path = (string) $info->getPathname();
				if ( str_contains( $path, DIRECTORY_SEPARATOR . '.git' . DIRECTORY_SEPARATOR ) ) {
					continue;
				}
				$files[] = $path;
			}
		}
		sort( $files );

		return $files;
	}

	private static function glob_match( string $pattern, string $subject ): bool {
		$basename = basename( $subject );
		return fnmatch( $pattern, $subject ) || fnmatch( $pattern, $basename );
	}

	private static function looks_binary( string $content ): bool {
		$sample = substr( $content, 0, 8000 );
		return str_contains( $sample, "\0" );
	}

	/**
	 * @param array<string,mixed> $parameters Tool parameters.
	 * @param array<int,string>   $keys Candidate keys.
	 */
	private static function first_string( array $parameters, array $keys ): string {
		foreach ( $keys as $key ) {
			if ( isset( $parameters[ $key ] ) && is_scalar( $parameters[ $key ] ) ) {
				return (string) $parameters[ $key ];
			}
		}

		return '';
	}

	private static function replace_first( string $haystack, string $needle, string $replacement ): string {
		$pos = strpos( $haystack, $needle );
		if ( false === $pos ) {
			return $haystack;
		}

		return substr_replace( $haystack, $replacement, $pos, strlen( $needle ) );
	}

	// -----------------------------------------------------------------
	// Filesystem helpers (WordPress-aware with plain PHP fallbacks).
	// -----------------------------------------------------------------

	private static function read_raw( string $path ): ?string {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents -- Bounded local sandbox file, not a remote URL.
		$content = file_get_contents( $path );

		return false === $content ? null : $content;
	}

	private static function write_raw( string $path, string $content ): bool {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents -- Bounded local sandbox file.
		return false !== file_put_contents( $path, $content );
	}

	private static function mkdir_p( string $path ): bool {
		if ( is_dir( $path ) ) {
			return true;
		}
		if ( function_exists( 'wp_mkdir_p' ) ) {
			return (bool) wp_mkdir_p( $path );
		}

		// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_mkdir -- Bounded local sandbox directory.
		return mkdir( $path, 0755, true ) || is_dir( $path );
	}

	private static function unlink_path( string $path ): bool {
		// phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink -- Bounded local sandbox file.
		return @unlink( $path );
	}

	// -----------------------------------------------------------------
	// Result envelopes + metrics.
	// -----------------------------------------------------------------

	/**
	 * @return array<string,mixed>
	 */
	private static function tool_error( string $type, string $message ): array {
		return array(
			'success'    => false,
			'error'      => $message,
			'error_type' => $type,
		);
	}

	/**
	 * @param array<string,mixed> $config Tool config.
	 * @return array<string,mixed>
	 */
	private static function runtime_metadata( array $config ): array {
		return array(
			'executor_target'      => self::TARGET_ID,
			'capability'           => $config['capability'],
			'side_effects'         => $config['side_effects'],
			'side_effect_boundary' => 'wp-codebox-sandbox',
		);
	}

	/**
	 * @param array<string,mixed>|null $config Tool config.
	 * @return array<string,mixed>
	 */
	private static function error_result( string $tool_name, string $message, string $error_type, ?array $config, float $started_at ): array {
		$runtime = array(
			'executor_target'      => self::TARGET_ID,
			'side_effect_boundary' => 'wp-codebox-sandbox',
		);
		if ( null !== $config ) {
			$runtime = self::runtime_metadata( $config );
		}

		return array(
			'success'           => false,
			'tool_name'         => $tool_name,
			'error'             => $message,
			'error_type'        => $error_type,
			'runtime'           => $runtime,
			'execution_metrics' => self::execution_metrics( $tool_name, $config, array(), null, $started_at, $error_type ),
		);
	}

	/**
	 * @param array<string,mixed>|null $config Tool config.
	 * @param array<string,mixed>      $parameters Tool parameters.
	 * @param mixed                    $output Tool output.
	 * @return array<string,mixed>
	 */
	private static function execution_metrics( string $tool_name, ?array $config, array $parameters, $output, float $started_at, ?string $failure_class ): array {
		return array(
			'executor_target'      => self::TARGET_ID,
			'tool_name'            => $tool_name,
			'wall_time_ms'         => round( max( 0, microtime( true ) - $started_at ) * 1000, 3 ),
			'payload_bytes'        => array(
				'input'  => self::payload_bytes( $parameters ),
				'output' => null === $output ? 0 : self::payload_bytes( $output ),
			),
			'side_effect_classes'  => null === $config ? array() : self::side_effect_classes( $config ),
			'side_effect_boundary' => 'wp-codebox-sandbox',
			'failure_class'        => $failure_class,
		);
	}

	/**
	 * @param array<string,mixed> $config Tool config.
	 * @return array<int,string>
	 */
	private static function side_effect_classes( array $config ): array {
		$classes = array();
		foreach ( $config['side_effects'] as $side_effect ) {
			$parts = explode( '.', (string) $side_effect, 2 );
			if ( '' !== $parts[0] ) {
				$classes[] = $parts[0];
			}
		}

		return array_values( array_unique( $classes ) );
	}

	/**
	 * @param mixed $payload Payload to size without retaining contents.
	 */
	private static function payload_bytes( $payload ): int {
		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $payload ) : json_encode( $payload );

		return is_string( $encoded ) ? strlen( $encoded ) : 0;
	}
}
