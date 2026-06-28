<?php
/**
 * Runner workspace executor behavior.
 *
 * Shared tool-name -> engine mapping and workspace-root resolution for the
 * runner workspace executor. Kept in a trait so the executor can implement the
 * Agents API tool-executor interface only when that interface is loaded.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

trait WP_Codebox_Runner_Workspace_Executor_Behavior {

	public const TARGET_ID = 'wp-codebox/runner-workspace';

	/**
	 * Agents API tool source slug for the runner-native tool surface.
	 *
	 * Distinct from the git-less sandbox executor's `client` source so the two
	 * surfaces never collide when both plugins are mounted in the same runtime.
	 */
	public const SOURCE_SLUG = 'wp-codebox-runner';

	/** Constant a runner may define to pin its workspace root. */
	public const WORKSPACE_ROOT_CONSTANT = 'WP_CODEBOX_RUNNER_WORKSPACE_ROOT';

	/** Guards one-time registration onto the Agents API filters. */
	private static bool $registered = false;

	/**
	 * Agent-facing tool names mapped to engine operations. Tool names are the
	 * codebox-native surface; engine methods do the real work.
	 *
	 * @return array<string,string>
	 */
	public static function tool_map(): array {
		return array(
			'workspace-read'                => 'read',
			'workspace-ls'                  => 'ls',
			'workspace-grep'                => 'grep',
			'workspace-write'               => 'write',
			'workspace-edit'                => 'edit',
			'workspace-apply-patch'         => 'apply_patch',
			'workspace-git-status'          => 'git_status',
			'workspace-git-diff'            => 'git_diff',
			'workspace-git-add'             => 'git_add',
			'workspace-git-commit'          => 'git_commit',
			'workspace-git-push'            => 'git_push',
			'create-github-pull-request'    => 'create_pull_request',
			'create-github-issue'           => 'create_issue',
			'comment-github-pull-request'   => 'comment_pull_request',
		);
	}

	/**
	 * Capability and side-effect metadata per agent-facing tool.
	 *
	 * Keyed by the base tool name from {@see tool_map()}. Side effects classify
	 * each tool so a host can reason about its blast radius the same way the
	 * git-less sandbox executor does.
	 *
	 * @return array<string,array{capability:string,description:string,side_effects:array<int,string>,parameters:array<string,mixed>}>
	 */
	public static function tool_metadata(): array {
		$path_param = array(
			'type'        => 'string',
			'description' => 'Workspace-root-relative file or directory path.',
		);

		return array(
			'workspace-read'              => array(
				'capability'   => 'workspace.files.read',
				'description'  => 'Read a text file from the runner workspace.',
				'side_effects' => array(),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'path' ),
					'properties' => array( 'path' => $path_param ),
				),
			),
			'workspace-ls'                => array(
				'capability'   => 'workspace.files.read',
				'description'  => 'List directory contents within the runner workspace.',
				'side_effects' => array(),
				'parameters'   => array(
					'type'       => 'object',
					'properties' => array( 'path' => $path_param ),
				),
			),
			'workspace-grep'              => array(
				'capability'   => 'workspace.files.read',
				'description'  => 'Search workspace files with git grep.',
				'side_effects' => array(),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'query' ),
					'properties' => array(
						'query'         => array( 'type' => 'string', 'description' => 'Pattern to search for.' ),
						'path'          => $path_param,
						'ignore_case'   => array( 'type' => 'boolean', 'description' => 'Case-insensitive match.' ),
						'fixed_strings' => array( 'type' => 'boolean', 'description' => 'Treat the query as a literal string.' ),
					),
				),
			),
			'workspace-write'             => array(
				'capability'   => 'workspace.files.write',
				'description'  => 'Create or overwrite a file in the runner workspace.',
				'side_effects' => array( 'filesystem.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'path', 'content' ),
					'properties' => array(
						'path'    => $path_param,
						'content' => array( 'type' => 'string', 'description' => 'File content to write.' ),
					),
				),
			),
			'workspace-edit'              => array(
				'capability'   => 'workspace.files.write',
				'description'  => 'Find-and-replace text in a runner workspace file.',
				'side_effects' => array( 'filesystem.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'path', 'old' ),
					'properties' => array(
						'path'        => $path_param,
						'old'         => array( 'type' => 'string', 'description' => 'Text to find.' ),
						'new'         => array( 'type' => 'string', 'description' => 'Replacement text.' ),
						'replace_all' => array( 'type' => 'boolean', 'description' => 'Replace every occurrence (default false).' ),
					),
				),
			),
			'workspace-apply-patch'       => array(
				'capability'   => 'workspace.files.write',
				'description'  => 'Apply a unified diff to the runner workspace via git apply.',
				'side_effects' => array( 'filesystem.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'patch' ),
					'properties' => array(
						'patch' => array( 'type' => 'string', 'description' => 'Unified diff content to apply.' ),
					),
				),
			),
			'workspace-git-status'        => array(
				'capability'   => 'workspace.git.read',
				'description'  => 'Report git status for the runner workspace.',
				'side_effects' => array(),
				'parameters'   => array( 'type' => 'object', 'properties' => array() ),
			),
			'workspace-git-diff'          => array(
				'capability'   => 'workspace.git.read',
				'description'  => 'Show the git diff for the runner workspace.',
				'side_effects' => array(),
				'parameters'   => array(
					'type'       => 'object',
					'properties' => array(
						'path'   => $path_param,
						'staged' => array( 'type' => 'boolean', 'description' => 'Diff staged (cached) changes.' ),
					),
				),
			),
			'workspace-git-add'           => array(
				'capability'   => 'workspace.git.write',
				'description'  => 'Stage paths in the runner workspace.',
				'side_effects' => array( 'git.index' ),
				'parameters'   => array(
					'type'       => 'object',
					'properties' => array(
						'paths' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ), 'description' => 'Paths to stage (defaults to all).' ),
					),
				),
			),
			'workspace-git-commit'        => array(
				'capability'   => 'workspace.git.write',
				'description'  => 'Commit staged changes in the runner workspace.',
				'side_effects' => array( 'git.commit' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'message' ),
					'properties' => array(
						'message'      => array( 'type' => 'string', 'description' => 'Commit message.' ),
						'author_name'  => array( 'type' => 'string', 'description' => 'Optional commit author name.' ),
						'author_email' => array( 'type' => 'string', 'description' => 'Optional commit author email.' ),
					),
				),
			),
			'workspace-git-push'          => array(
				'capability'   => 'workspace.git.push',
				'description'  => 'Push the runner workspace branch to its remote.',
				'side_effects' => array( 'git.push', 'network.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'properties' => array(
						'remote'           => array( 'type' => 'string', 'description' => 'Remote name (default origin).' ),
						'branch'           => array( 'type' => 'string', 'description' => 'Branch to push.' ),
						'set_upstream'     => array( 'type' => 'boolean', 'description' => 'Set upstream tracking.' ),
						'force_with_lease' => array( 'type' => 'boolean', 'description' => 'Force push with lease.' ),
					),
				),
			),
			'create-github-pull-request'  => array(
				'capability'   => 'github.pull_request.write',
				'description'  => 'Open a GitHub pull request from the runner workspace.',
				'side_effects' => array( 'github.write', 'network.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'repo', 'title', 'head', 'base' ),
					'properties' => array(
						'repo'  => array( 'type' => 'string', 'description' => 'owner/repo slug.' ),
						'title' => array( 'type' => 'string', 'description' => 'Pull request title.' ),
						'head'  => array( 'type' => 'string', 'description' => 'Head branch.' ),
						'base'  => array( 'type' => 'string', 'description' => 'Base branch.' ),
						'body'  => array( 'type' => 'string', 'description' => 'Pull request body.' ),
						'draft' => array( 'type' => 'boolean', 'description' => 'Open as a draft.' ),
					),
				),
			),
			'create-github-issue'         => array(
				'capability'   => 'github.issue.write',
				'description'  => 'Open a GitHub issue from the runner workspace.',
				'side_effects' => array( 'github.write', 'network.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'repo', 'title' ),
					'properties' => array(
						'repo'   => array( 'type' => 'string', 'description' => 'owner/repo slug.' ),
						'title'  => array( 'type' => 'string', 'description' => 'Issue title.' ),
						'body'   => array( 'type' => 'string', 'description' => 'Issue body.' ),
						'labels' => array( 'type' => 'array', 'items' => array( 'type' => 'string' ), 'description' => 'Issue labels.' ),
					),
				),
			),
			'comment-github-pull-request' => array(
				'capability'   => 'github.pull_request.comment',
				'description'  => 'Comment on a GitHub pull request from the runner workspace.',
				'side_effects' => array( 'github.write', 'network.write' ),
				'parameters'   => array(
					'type'       => 'object',
					'required'   => array( 'repo', 'number', 'body' ),
					'properties' => array(
						'repo'   => array( 'type' => 'string', 'description' => 'owner/repo slug.' ),
						'number' => array( 'type' => 'integer', 'description' => 'Pull request number.' ),
						'body'   => array( 'type' => 'string', 'description' => 'Comment body.' ),
					),
				),
			),
		);
	}

	/**
	 * The side-effect boundary tag this executor stamps on every result/metric.
	 */
	public const SIDE_EFFECT_BOUNDARY = 'wp-codebox-runner';

	/**
	 * Register the runner-workspace executor onto the live Agents API contract.
	 *
	 * Mirrors the git-less sandbox executor: declares its tools as an Agents API
	 * tool source (each carrying `runtime.executor_target`), registers an
	 * executor target descriptor, and registers a tool-call executor under the
	 * target id so registry-based dispatch routes matching calls here. Idempotent;
	 * no-ops until the Agents API tool-execution substrate is loaded.
	 */
	public static function register(): bool {
		if ( self::$registered ) {
			return true;
		}

		if ( ! function_exists( 'add_filter' ) || ! self::substrate_exists() ) {
			return false;
		}

		add_filter( 'agents_api_tool_sources', array( self::class, 'register_tool_source' ), 20, 3 );
		add_filter( 'agents_api_executor_targets', array( self::class, 'register_executor_target' ), 20, 2 );
		add_filter( 'agents_api_execution_targets', array( self::class, 'register_executor_target' ), 20, 2 );
		add_filter( 'agents_api_tool_executors', array( self::class, 'register_tool_executor' ), 20, 2 );

		self::$registered = true;
		return true;
	}

	/**
	 * Whether the Agents API generic tool-execution substrate is loaded.
	 *
	 * Both the executor interface and the source registry must be present, the
	 * same gate the git-less sandbox executor uses, so the runner load path is
	 * verified before any registration runs.
	 */
	public static function substrate_exists(): bool {
		return interface_exists( 'AgentsAPI\\AI\\Tools\\WP_Agent_Tool_Executor' )
			&& class_exists( 'AgentsAPI\\AI\\Tools\\WP_Agent_Tool_Source_Registry' );
	}

	/**
	 * Register the runner-native tool surface as an Agents API tool source.
	 *
	 * @param array<string,callable> $sources Existing sources.
	 * @param array<string,mixed>    $context Runtime context.
	 * @param mixed                  $registry Source registry.
	 * @return array<string,callable>
	 */
	public static function register_tool_source( array $sources, array $context = array(), $registry = null ): array {
		unset( $context, $registry );

		$existing                     = $sources[ self::SOURCE_SLUG ] ?? null;
		$sources[ self::SOURCE_SLUG ] = static function ( array $source_context = array(), $source_registry = null ) use ( $existing ): array {
			$tools = is_callable( $existing ) ? call_user_func( $existing, $source_context, $source_registry ) : array();
			if ( ! is_array( $tools ) ) {
				$tools = array();
			}

			foreach ( self::tool_declarations() as $tool_name => $tool_declaration ) {
				if ( ! isset( $tools[ $tool_name ] ) ) {
					$tools[ $tool_name ] = $tool_declaration;
				}
			}

			return $tools;
		};

		return $sources;
	}

	/**
	 * Register this executor as an Agents API executor target descriptor.
	 *
	 * @param array<string,mixed> $targets Existing targets.
	 * @param array<string,mixed> $context Runtime context.
	 * @return array<string,mixed>
	 */
	public static function register_executor_target( array $targets, array $context = array() ): array {
		unset( $context );

		$targets[ self::TARGET_ID ] = self::target_metadata();
		return $targets;
	}

	/**
	 * Register the tool-call executor for registry-based dispatch.
	 *
	 * A new executor instance is keyed under the target id so the Agents API
	 * tool-executor registry resolves `runtime.executor_target` calls here.
	 *
	 * @param array<string,mixed> $executors Existing executors.
	 * @param array<string,mixed> $context Runtime context.
	 * @return array<string,mixed>
	 */
	public static function register_tool_executor( array $executors, array $context = array() ): array {
		unset( $context );

		$executors[ self::TARGET_ID ] = new self();
		return $executors;
	}

	/**
	 * Agents API tool declarations for the runner-native surface.
	 *
	 * @return array<string,array<string,mixed>>
	 */
	public static function tool_declarations(): array {
		$tools    = array();
		$metadata = self::tool_metadata();
		foreach ( self::tool_map() as $base => $operation ) {
			unset( $operation );
			$config         = $metadata[ $base ] ?? array();
			$qualified_name = self::SOURCE_SLUG . '/' . $base;
			$tools[ $qualified_name ] = array(
				'name'        => $qualified_name,
				'source'      => self::SOURCE_SLUG,
				'description' => (string) ( $config['description'] ?? '' ),
				'parameters'  => $config['parameters'] ?? array( 'type' => 'object', 'properties' => array() ),
				'executor'    => 'host',
				'scope'       => 'run',
				'runtime'     => array(
					'executor_target'      => self::TARGET_ID,
					'capability'           => (string) ( $config['capability'] ?? '' ),
					'side_effects'         => $config['side_effects'] ?? array(),
					'side_effect_boundary' => self::SIDE_EFFECT_BOUNDARY,
				),
			);
		}

		return $tools;
	}

	/**
	 * Target metadata for generic Agents API executor discovery.
	 *
	 * @return array<string,mixed>
	 */
	public static function target_metadata(): array {
		$metadata = self::tool_metadata();

		return array(
			'id'                    => self::TARGET_ID,
			'label'                 => 'WP Codebox runner workspace',
			'description'           => 'Runner-native git + GitHub + file agent-tool surface bound to a single runner workspace root. Replaces the external coding-agent plugin dependency for the runner agent-facing surface.',
			'resource_class'        => 'workspace',
			'kind'                  => 'runner-workspace',
			'required_capabilities' => array_values(
				array_unique(
					array_filter(
						array_map(
							static fn( array $config ): string => (string) ( $config['capability'] ?? '' ),
							$metadata
						)
					)
				)
			),
			'side_effect_boundary'  => self::SIDE_EFFECT_BOUNDARY,
			'side_effects'          => array( 'filesystem.write', 'git.commit', 'git.push', 'github.write', 'network.write' ),
		);
	}

	/**
	 * Execute a tool call against the engine bound to the resolved workspace root.
	 *
	 * @param array<string,mixed> $parameters
	 * @param array<string,mixed> $context
	 * @return array<string,mixed>
	 */
	public function execute_tool( string $tool_name, array $parameters, array $context = array() ): array {
		$operation = self::tool_map()[ self::normalize_tool_name( $tool_name ) ] ?? '';
		if ( '' === $operation ) {
			return array(
				'success' => false,
				'error'   => array(
					'code'    => 'wp_codebox_runner_workspace_unknown_tool',
					'message' => sprintf( 'Runner workspace executor does not handle tool "%s".', $tool_name ),
				),
			);
		}

		$root = self::resolve_workspace_root( $parameters, $context );
		if ( '' === $root || ! is_dir( $root ) ) {
			return array(
				'success' => false,
				'error'   => array(
					'code'    => 'wp_codebox_runner_workspace_root_unavailable',
					'message' => 'Runner workspace root is not configured or does not exist.',
				),
			);
		}

		$engine = new WP_Codebox_Runner_Workspace_Tools( $root );
		/** @var callable $callable */
		$callable = array( $engine, $operation );
		return (array) $callable( $parameters );
	}

	private static function normalize_tool_name( string $tool_name ): string {
		$tool_name = trim( $tool_name );
		// Accept namespaced declarations like "wp-codebox/workspace-read".
		$slash = strrpos( $tool_name, '/' );
		return false !== $slash ? substr( $tool_name, $slash + 1 ) : $tool_name;
	}

	/**
	 * Resolve the workspace root the tools operate on. Explicit per-call input
	 * wins, then the runtime client context, then a runner-defined constant,
	 * then an integration filter.
	 *
	 * @param array<string,mixed> $parameters
	 * @param array<string,mixed> $context
	 */
	public static function resolve_workspace_root( array $parameters, array $context = array() ): string {
		$explicit = trim( (string) ( $parameters['workspace_root'] ?? $context['workspace_root'] ?? '' ) );
		if ( '' !== $explicit ) {
			return self::canonical_root( $explicit );
		}

		$from_context = self::workspace_root_from_context( $context );
		if ( '' !== $from_context ) {
			return self::canonical_root( $from_context );
		}

		if ( defined( self::WORKSPACE_ROOT_CONSTANT ) ) {
			$constant = (string) constant( self::WORKSPACE_ROOT_CONSTANT );
			if ( '' !== trim( $constant ) ) {
				return self::canonical_root( $constant );
			}
		}

		if ( function_exists( 'apply_filters' ) ) {
			$filtered = apply_filters( 'wp_codebox_runner_workspace_root', '', $parameters, $context );
			if ( is_string( $filtered ) && '' !== trim( $filtered ) ) {
				return self::canonical_root( $filtered );
			}
		}

		return '';
	}

	/** @param array<string,mixed> $context */
	private static function workspace_root_from_context( array $context ): string {
		$candidates = array(
			$context['default_workspace']['target'] ?? null,
			$context['sandbox_workspace']['root'] ?? null,
		);
		foreach ( is_array( $context['sandbox_workspace']['mounts'] ?? null ) ? $context['sandbox_workspace']['mounts'] : array() as $mount ) {
			if ( is_array( $mount ) && 'readwrite' === ( $mount['mode'] ?? '' ) && is_string( $mount['target'] ?? null ) ) {
				$candidates[] = $mount['target'];
			}
		}
		foreach ( $candidates as $candidate ) {
			if ( is_string( $candidate ) && '' !== trim( $candidate ) ) {
				return trim( $candidate );
			}
		}
		return '';
	}

	private static function canonical_root( string $root ): string {
		$resolved = realpath( $root );
		return false !== $resolved ? $resolved : rtrim( $root, '/' );
	}
}
