<?php
/**
 * Native runner-workspace tool engine.
 *
 * WordPress-independent engine that performs the agent-facing file, git, and
 * GitHub operations directly against a runner workspace root. Owned by WP
 * Codebox so the runner stops depending on an external coding-agent plugin
 * for its git/GitHub agent-tool surface.
 *
 * Every method is bound to a single workspace root and confines filesystem
 * access to that root. Git operations shell out to the local `git` binary.
 * GitHub operations build authenticated REST requests (env-token auth) and
 * send them through an injectable transport so request construction can be
 * asserted deterministically without a network.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Runner_Workspace_Tools {

	/** @var string Absolute, resolved workspace root. */
	private string $root;

	/** @var callable(string $method, string $url, array<string,string> $headers, ?string $body):array<string,mixed> */
	private $http_transport;

	/** @var list<string> Canonical repositories allowed for GitHub mutations. */
	private array $allowed_repos;

	/** @var list<string> Environment variable names consulted for a GitHub token, in order. */
	private const GITHUB_TOKEN_ENV_VARS = array( 'GITHUB_TOKEN', 'GH_TOKEN' );

	/**
	 * @param string        $root           Workspace root directory (must already exist).
	 * @param callable|null $http_transport Optional GitHub HTTP transport override for testing.
	 * @param list<string>  $allowed_repos Explicit GitHub repository allowlist for this runtime.
	 */
	public function __construct( string $root, ?callable $http_transport = null, array $allowed_repos = array() ) {
		$resolved   = realpath( $root );
		$this->root = false !== $resolved ? $resolved : rtrim( $root, '/' );
		$this->http_transport = $http_transport ?? array( $this, 'default_http_transport' );
		$this->allowed_repos  = $this->normalize_allowed_repos( $allowed_repos );
	}

	public function root(): string {
		return $this->root;
	}

	/* ---------------------------------------------------------------------
	 * File tools
	 * ------------------------------------------------------------------- */

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function read( array $input ): array {
		$path = $this->resolve_path( (string) ( $input['path'] ?? '' ), true );
		if ( is_array( $path ) ) {
			return $path;
		}
		if ( ! is_file( $path ) || ! is_readable( $path ) ) {
			return $this->failure( 'file_not_readable', 'Workspace file is not readable.' );
		}
		$content = file_get_contents( $path );
		if ( false === $content ) {
			return $this->failure( 'file_read_failed', 'Workspace file could not be read.' );
		}
		return array(
			'success' => true,
			'path'    => $this->relative( $path ),
			'bytes'   => strlen( $content ),
			'content' => $content,
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function ls( array $input ): array {
		$relative = trim( (string) ( $input['path'] ?? '' ) );
		$target   = '' === $relative ? $this->root : $this->resolve_path( $relative, true );
		if ( is_array( $target ) ) {
			return $target;
		}
		if ( ! is_dir( $target ) ) {
			return $this->failure( 'not_a_directory', 'Workspace path is not a directory.' );
		}
		$entries = array();
		foreach ( scandir( $target ) ?: array() as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}
			$full      = $target . '/' . $entry;
			$entries[] = array(
				'name' => $entry,
				'type' => is_dir( $full ) ? 'dir' : 'file',
			);
		}
		return array(
			'success' => true,
			'path'    => '' === $relative ? '.' : $this->relative( $target ),
			'entries' => $entries,
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function grep( array $input ): array {
		$query = (string) ( $input['query'] ?? '' );
		if ( '' === $query ) {
			return $this->failure( 'invalid_request', 'grep requires a query.' );
		}
		$args = array( 'grep', '-n', '-I', '--no-color', '--untracked' );
		if ( ! empty( $input['ignore_case'] ) ) {
			$args[] = '-i';
		}
		if ( ! empty( $input['fixed_strings'] ) ) {
			$args[] = '-F';
		}
		$args[] = '-e';
		$args[] = $query;
		$pathspec = $this->grep_pathspec( $input );
		if ( array() !== $pathspec ) {
			$args[] = '--';
			$args   = array_merge( $args, $pathspec );
		}
		$result = $this->git( $args );
		// git grep exits 1 with no matches; treat that as an empty, successful result.
		if ( ! $result['ok'] && 1 !== $result['exit_code'] ) {
			return $this->git_failure( 'grep', $result );
		}
		$matches = array();
		foreach ( preg_split( '/\r?\n/', $result['stdout'] ) ?: array() as $line ) {
			if ( '' === $line ) {
				continue;
			}
			if ( preg_match( '/^(.*?):(\d+):(.*)$/', $line, $m ) ) {
				$matches[] = array( 'path' => $m[1], 'line' => (int) $m[2], 'text' => $m[3] );
			}
		}
		return array( 'success' => true, 'query' => $query, 'matches' => $matches );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function write( array $input ): array {
		$path = $this->resolve_path( (string) ( $input['path'] ?? '' ), false );
		if ( is_array( $path ) ) {
			return $path;
		}
		$content = (string) ( $input['content'] ?? '' );
		$dir     = dirname( $path );
		if ( ! is_dir( $dir ) && ! mkdir( $dir, 0777, true ) && ! is_dir( $dir ) ) {
			return $this->failure( 'directory_create_failed', 'Workspace directory could not be created.' );
		}
		if ( false === file_put_contents( $path, $content ) ) {
			return $this->failure( 'file_write_failed', 'Workspace file could not be written.' );
		}
		return array(
			'success' => true,
			'path'    => $this->relative( $path ),
			'bytes'   => strlen( $content ),
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function edit( array $input ): array {
		$path = $this->resolve_path( (string) ( $input['path'] ?? '' ), true );
		if ( is_array( $path ) ) {
			return $path;
		}
		if ( ! is_file( $path ) ) {
			return $this->failure( 'file_not_found', 'Workspace file does not exist.' );
		}
		$old = (string) ( $input['old'] ?? $input['old_string'] ?? '' );
		$new = (string) ( $input['new'] ?? $input['new_string'] ?? '' );
		if ( '' === $old ) {
			return $this->failure( 'invalid_request', 'edit requires a non-empty old string.' );
		}
		$content = (string) file_get_contents( $path );
		$count   = substr_count( $content, $old );
		if ( 0 === $count ) {
			return $this->failure( 'edit_no_match', 'edit old string was not found in the file.' );
		}
		$replace_all = ! empty( $input['replace_all'] );
		if ( ! $replace_all && $count > 1 ) {
			return $this->failure( 'edit_not_unique', 'edit old string is not unique; pass replace_all to replace every occurrence.' );
		}
		$updated = $replace_all
			? str_replace( $old, $new, $content )
			: $this->replace_first( $content, $old, $new );
		if ( false === file_put_contents( $path, $updated ) ) {
			return $this->failure( 'file_write_failed', 'Workspace file could not be written.' );
		}
		return array(
			'success'      => true,
			'path'         => $this->relative( $path ),
			'replacements' => $replace_all ? $count : 1,
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function apply_patch( array $input ): array {
		$patch = (string) ( $input['patch'] ?? $input['diff'] ?? '' );
		if ( '' === trim( $patch ) ) {
			return $this->failure( 'invalid_request', 'apply_patch requires a unified diff.' );
		}
		$tmp = tempnam( sys_get_temp_dir(), 'wpcodebox-patch-' );
		if ( false === $tmp || false === file_put_contents( $tmp, $patch ) ) {
			return $this->failure( 'patch_staging_failed', 'Patch could not be staged for application.' );
		}
		try {
			$check = $this->git( array( 'apply', '--check', $tmp ) );
			if ( ! $check['ok'] ) {
				return $this->git_failure( 'apply_patch', $check );
			}
			$apply = $this->git( array( 'apply', $tmp ) );
			if ( ! $apply['ok'] ) {
				return $this->git_failure( 'apply_patch', $apply );
			}
		} finally {
			@unlink( $tmp );
		}
		return array( 'success' => true, 'applied' => true );
	}

	/* ---------------------------------------------------------------------
	 * Git tools
	 * ------------------------------------------------------------------- */

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function git_status( array $input = array() ): array {
		$porcelain = $this->git( array( 'status', '--porcelain=v1', '--branch' ) );
		if ( ! $porcelain['ok'] ) {
			return $this->git_failure( 'git_status', $porcelain );
		}
		$branch = '';
		$files  = array();
		foreach ( preg_split( '/\r?\n/', $porcelain['stdout'] ) ?: array() as $line ) {
			if ( '' === $line ) {
				continue;
			}
			if ( str_starts_with( $line, '## ' ) ) {
				$branch = $this->parse_branch_header( substr( $line, 3 ) );
				continue;
			}
			$files[] = array(
				'status' => trim( substr( $line, 0, 2 ) ),
				'path'   => trim( substr( $line, 3 ) ),
			);
		}
		return array(
			'success' => true,
			'branch'  => $branch,
			'dirty'   => count( $files ),
			'files'   => $files,
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function git_diff( array $input = array() ): array {
		$args = array( 'diff' );
		if ( ! empty( $input['staged'] ) || ! empty( $input['cached'] ) ) {
			$args[] = '--cached';
		}
		$path = trim( (string) ( $input['path'] ?? '' ) );
		if ( '' !== $path ) {
			$args[] = '--';
			$args[] = $path;
		}
		$result = $this->git( $args );
		if ( ! $result['ok'] ) {
			return $this->git_failure( 'git_diff', $result );
		}
		return array( 'success' => true, 'diff' => $result['stdout'] );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function git_add( array $input ): array {
		$paths = $this->string_list( $input['paths'] ?? $input['path'] ?? array() );
		if ( array() === $paths ) {
			$paths = array( '-A' );
		}
		$result = $this->git( array_merge( array( 'add' ), $paths ) );
		if ( ! $result['ok'] ) {
			return $this->git_failure( 'git_add', $result );
		}
		return array( 'success' => true, 'added' => $paths );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function git_commit( array $input ): array {
		$message = (string) ( $input['message'] ?? '' );
		if ( '' === trim( $message ) ) {
			return $this->failure( 'invalid_request', 'git_commit requires a message.' );
		}
		$env  = array();
		$name = trim( (string) ( $input['author_name'] ?? '' ) );
		$mail = trim( (string) ( $input['author_email'] ?? '' ) );
		if ( '' !== $name ) {
			$env['GIT_AUTHOR_NAME']    = $name;
			$env['GIT_COMMITTER_NAME'] = $name;
		}
		if ( '' !== $mail ) {
			$env['GIT_AUTHOR_EMAIL']    = $mail;
			$env['GIT_COMMITTER_EMAIL'] = $mail;
		}
		$result = $this->git( array( 'commit', '-m', $message ), $env );
		if ( ! $result['ok'] ) {
			return $this->git_failure( 'git_commit', $result );
		}
		$sha = $this->git( array( 'rev-parse', 'HEAD' ) );
		return array(
			'success' => true,
			'sha'     => $sha['ok'] ? trim( $sha['stdout'] ) : '',
			'message' => $message,
		);
	}

	/**
	 * Build the git push argv (and the token-authenticated remote URL, if any)
	 * without executing it. Separating construction from execution lets the
	 * push contract be asserted deterministically without a network.
	 *
	 * @param array<string,mixed> $input
	 * @return array<string,mixed>
	 */
	public function build_git_push( array $input ): array {
		$remote = trim( (string) ( $input['remote'] ?? 'origin' ) );
		$branch = trim( (string) ( $input['branch'] ?? '' ) );
		$args   = array( 'push' );
		if ( ! empty( $input['set_upstream'] ) ) {
			$args[] = '--set-upstream';
		}
		if ( ! empty( $input['force_with_lease'] ) ) {
			$args[] = '--force-with-lease';
		}
		$args[] = $remote;
		if ( '' !== $branch ) {
			$args[] = $branch;
		}
		return array(
			'success' => true,
			'argv'    => array_merge( array( 'git' ), $args ),
			'remote'  => $remote,
			'branch'  => $branch,
		);
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function git_push( array $input ): array {
		$plan = $this->build_git_push( $input );
		$args = array_slice( $plan['argv'], 1 );
		$result = $this->git( $args );
		if ( ! $result['ok'] ) {
			return $this->git_failure( 'git_push', $result );
		}
		return array(
			'success' => true,
			'remote'  => $plan['remote'],
			'branch'  => $plan['branch'],
			'stdout'  => $result['stdout'],
			'stderr'  => $result['stderr'],
		);
	}

	/* ---------------------------------------------------------------------
	 * GitHub tools
	 * ------------------------------------------------------------------- */

	/**
	 * Build the authenticated GitHub REST request for opening a pull request.
	 *
	 * @param array<string,mixed> $input
	 * @return array<string,mixed>
	 */
	public function build_create_pull_request( array $input ): array {
		$repo = $this->normalize_repo( (string) ( $input['repo'] ?? '' ) );
		if ( is_array( $repo ) ) {
			return $repo;
		}
		$missing = $this->missing_fields( $input, array( 'title', 'head', 'base' ) );
		if ( array() !== $missing ) {
			return $this->failure( 'invalid_request', 'create_pull_request requires title, head, and base.', array( 'missing' => $missing ) );
		}
		$body = array_filter(
			array(
				'title' => (string) $input['title'],
				'head'  => (string) $input['head'],
				'base'  => (string) $input['base'],
				'body'  => (string) ( $input['body'] ?? '' ),
				'draft' => ! empty( $input['draft'] ) ? true : null,
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
		);
		return $this->build_github_request( 'POST', "repos/{$repo}/pulls", $body, $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function build_create_issue( array $input ): array {
		$repo = $this->normalize_repo( (string) ( $input['repo'] ?? '' ) );
		if ( is_array( $repo ) ) {
			return $repo;
		}
		if ( '' === trim( (string) ( $input['title'] ?? '' ) ) ) {
			return $this->failure( 'invalid_request', 'create_issue requires a title.', array( 'missing' => array( 'title' ) ) );
		}
		$body = array_filter(
			array(
				'title'  => (string) $input['title'],
				'body'   => (string) ( $input['body'] ?? '' ),
				'labels' => $this->string_list( $input['labels'] ?? array() ) ?: null,
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value && array() !== $value
		);
		return $this->build_github_request( 'POST', "repos/{$repo}/issues", $body, $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function build_comment_pull_request( array $input ): array {
		$repo = $this->normalize_repo( (string) ( $input['repo'] ?? '' ) );
		if ( is_array( $repo ) ) {
			return $repo;
		}
		$number = (int) ( $input['number'] ?? $input['pull_number'] ?? 0 );
		$comment = (string) ( $input['body'] ?? $input['comment'] ?? '' );
		if ( $number <= 0 || '' === trim( $comment ) ) {
			return $this->failure( 'invalid_request', 'comment_pull_request requires a pull number and body.' );
		}
		// PR comments are issue comments on the same number.
		return $this->build_github_request( 'POST', "repos/{$repo}/issues/{$number}/comments", array( 'body' => $comment ), $input );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function create_pull_request( array $input ): array {
		return $this->send_github( $this->build_create_pull_request( $input ) );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function create_issue( array $input ): array {
		return $this->send_github( $this->build_create_issue( $input ) );
	}

	/** @param array<string,mixed> $input @return array<string,mixed> */
	public function comment_pull_request( array $input ): array {
		return $this->send_github( $this->build_comment_pull_request( $input ) );
	}

	/**
	 * Resolve a GitHub token from the runner environment, mirroring the
	 * env-first credential contract used across the ecosystem.
	 */
	public function resolve_github_token( array $input = array() ): string {
		$explicit_env = trim( (string) ( $input['github_token_env'] ?? '' ) );
		$candidates   = '' !== $explicit_env ? array_merge( array( $explicit_env ), self::GITHUB_TOKEN_ENV_VARS ) : self::GITHUB_TOKEN_ENV_VARS;
		foreach ( $candidates as $env_var ) {
			$token = trim( (string) getenv( $env_var ) );
			if ( '' !== $token ) {
				return $token;
			}
		}
		return '';
	}

	/* ---------------------------------------------------------------------
	 * Internals
	 * ------------------------------------------------------------------- */

	/** @param array<string,mixed> $request @return array<string,mixed> */
	private function send_github( array $request ): array {
		if ( empty( $request['success'] ) ) {
			return $request;
		}
		$transport = $this->http_transport;
		$response  = $transport(
			(string) $request['method'],
			(string) $request['url'],
			is_array( $request['headers'] ?? null ) ? $request['headers'] : array(),
			isset( $request['body'] ) ? (string) $request['body'] : null
		);
		return array_merge( array( 'success' => ( (int) ( $response['status'] ?? 0 ) ) < 400 ), $response );
	}

	/**
	 * @param array<string,mixed> $body
	 * @param array<string,mixed> $input
	 * @return array<string,mixed>
	 */
	private function build_github_request( string $method, string $path, array $body, array $input ): array {
		$repo = $this->repo_from_github_path( $path );
		if ( '' === $repo || ! in_array( $repo, $this->allowed_repos, true ) ) {
			return $this->failure( 'github_repo_not_allowed', 'GitHub operation repository is not explicitly allowed by this runner runtime policy.' );
		}
		$token = $this->resolve_github_token( $input );
		if ( '' === $token ) {
			return $this->failure(
				'github_token_missing',
				'No GitHub token is available in the runner environment (GITHUB_TOKEN or GH_TOKEN).'
			);
		}
		$base = rtrim( (string) ( $input['github_api_base'] ?? 'https://api.github.com' ), '/' );
		return array(
			'success' => true,
			'method'  => $method,
			'url'     => $base . '/' . ltrim( $path, '/' ),
			'headers' => array(
				'Authorization' => 'token ' . $token,
				'Accept'        => 'application/vnd.github+json',
				'Content-Type'  => 'application/json',
				'User-Agent'    => 'wp-codebox-runner-workspace',
			),
			'body'    => wp_codebox_runner_workspace_json_encode( $body ),
		);
	}

	/**
	 * Default GitHub transport: WordPress HTTP API when available, else cURL.
	 *
	 * @param array<string,string> $headers
	 * @return array<string,mixed>
	 */
	private function default_http_transport( string $method, string $url, array $headers, ?string $body ): array {
		if ( function_exists( 'wp_remote_request' ) ) {
			$response = wp_remote_request(
				$url,
				array(
					'method'  => $method,
					'headers' => $headers,
					'body'    => $body,
					'timeout' => 30,
				)
			);
			if ( function_exists( 'is_wp_error' ) && is_wp_error( $response ) ) {
				return array( 'status' => 0, 'error' => $response->get_error_message() );
			}
			return array(
				'status' => (int) wp_remote_retrieve_response_code( $response ),
				'body'   => (string) wp_remote_retrieve_body( $response ),
			);
		}
		$handle = curl_init( $url );
		$flat   = array();
		foreach ( $headers as $key => $value ) {
			$flat[] = $key . ': ' . $value;
		}
		curl_setopt( $handle, CURLOPT_CUSTOMREQUEST, $method );
		curl_setopt( $handle, CURLOPT_HTTPHEADER, $flat );
		curl_setopt( $handle, CURLOPT_RETURNTRANSFER, true );
		if ( null !== $body ) {
			curl_setopt( $handle, CURLOPT_POSTFIELDS, $body );
		}
		$out    = curl_exec( $handle );
		$status = (int) curl_getinfo( $handle, CURLINFO_RESPONSE_CODE );
		curl_close( $handle );
		return array( 'status' => $status, 'body' => is_string( $out ) ? $out : '' );
	}

	/**
	 * Run a git subcommand inside the workspace root.
	 *
	 * @param list<string>          $args
	 * @param array<string,string>  $env
	 * @return array{ok:bool,exit_code:int,stdout:string,stderr:string}
	 */
	private function git( array $args, array $env = array() ): array {
		$command = array_merge( array( 'git', '-C', $this->root ), $args );
		$descriptors = array(
			1 => array( 'pipe', 'w' ),
			2 => array( 'pipe', 'w' ),
		);
		$process_env = array_merge( $this->inherited_env(), $env );
		$process = proc_open( $command, $descriptors, $pipes, $this->root, $process_env );
		if ( ! is_resource( $process ) ) {
			return array( 'ok' => false, 'exit_code' => -1, 'stdout' => '', 'stderr' => 'git could not be started.' );
		}
		$stdout = (string) stream_get_contents( $pipes[1] );
		$stderr = (string) stream_get_contents( $pipes[2] );
		fclose( $pipes[1] );
		fclose( $pipes[2] );
		$exit = proc_close( $process );
		return array(
			'ok'        => 0 === $exit,
			'exit_code' => $exit,
			'stdout'    => $stdout,
			'stderr'    => $stderr,
		);
	}

	/** @return array<string,string> */
	private function inherited_env(): array {
		$env = array();
		foreach ( array( 'PATH', 'HOME', 'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_SSH_COMMAND', 'SSH_AUTH_SOCK' ) as $key ) {
			$value = getenv( $key );
			if ( false !== $value ) {
				$env[ $key ] = $value;
			}
		}
		return $env;
	}

	/**
	 * Resolve a workspace-relative path, confined to the workspace root.
	 *
	 * @return string|array<string,mixed> Resolved absolute path, or a failure array.
	 */
	private function resolve_path( string $relative, bool $must_exist ) {
		$relative = trim( $relative );
		if ( '' === $relative ) {
			return $this->failure( 'invalid_request', 'A workspace-relative path is required.' );
		}
		if ( str_starts_with( $relative, '/' ) || preg_match( '#(^|/)\.\.(/|$)#', $relative ) ) {
			return $this->failure( 'path_escape', 'Workspace paths must be relative and cannot traverse outside the workspace root.' );
		}
		$candidate = $this->root . '/' . ltrim( $relative, '/' );
		$real      = realpath( $candidate );
		if ( false !== $real ) {
			return $this->is_inside( $real ) ? $real : $this->failure( 'path_escape', 'Workspace path escapes the workspace root.' );
		}
		if ( $must_exist ) {
			return $this->failure( 'path_not_found', 'Workspace path does not exist.' );
		}
		$parent = realpath( dirname( $candidate ) );
		if ( false !== $parent && $this->is_inside( $parent ) ) {
			return $parent . '/' . basename( $candidate );
		}
		// Parent does not exist yet; keep it within root lexically (write() will mkdir).
		return $candidate;
	}

	private function is_inside( string $path ): bool {
		return $path === $this->root || str_starts_with( $path, $this->root . '/' );
	}

	private function relative( string $absolute ): string {
		if ( $absolute === $this->root ) {
			return '.';
		}
		if ( str_starts_with( $absolute, $this->root . '/' ) ) {
			return substr( $absolute, strlen( $this->root ) + 1 );
		}
		return $absolute;
	}

	/** @param array<string,mixed> $input @return list<string> */
	private function grep_pathspec( array $input ): array {
		$paths = $this->string_list( $input['paths'] ?? $input['path'] ?? array() );
		return $paths;
	}

	private function replace_first( string $haystack, string $needle, string $replacement ): string {
		$position = strpos( $haystack, $needle );
		if ( false === $position ) {
			return $haystack;
		}
		return substr_replace( $haystack, $replacement, $position, strlen( $needle ) );
	}

	private function parse_branch_header( string $header ): string {
		// Examples: "main", "main...origin/main", "No commits yet on main".
		if ( str_starts_with( $header, 'No commits yet on ' ) ) {
			return trim( substr( $header, strlen( 'No commits yet on ' ) ) );
		}
		$header = trim( $header );
		$dots   = strpos( $header, '...' );
		return false !== $dots ? substr( $header, 0, $dots ) : $header;
	}

	/** @return string|array<string,mixed> */
	private function normalize_repo( string $repo ) {
		$repo = trim( $repo );
		if ( 1 !== preg_match( '#^[^/\s]+/[^/\s]+$#', $repo ) ) {
			return $this->failure( 'invalid_request', 'GitHub operations require a repo in owner/name form.' );
		}
		return strtolower( preg_replace( '/\.git$/', '', $repo ) ?? $repo );
	}

	/** @param list<mixed> $repositories @return list<string> */
	private function normalize_allowed_repos( array $repositories ): array {
		$normalized = array();
		foreach ( $repositories as $repository ) {
			$repo = $this->normalize_repo( is_string( $repository ) ? $repository : '' );
			if ( is_string( $repo ) ) {
				$normalized[] = $repo;
			}
		}
		return array_values( array_unique( $normalized ) );
	}

	private function repo_from_github_path( string $path ): string {
		if ( 1 !== preg_match( '#^repos/([^/]+/[^/]+)(?:/|$)#', ltrim( $path, '/' ), $matches ) ) {
			return '';
		}
		$repo = $this->normalize_repo( $matches[1] );
		return is_string( $repo ) ? $repo : '';
	}

	/**
	 * @param array<string,mixed> $input
	 * @param list<string>        $fields
	 * @return list<string>
	 */
	private function missing_fields( array $input, array $fields ): array {
		$missing = array();
		foreach ( $fields as $field ) {
			if ( '' === trim( (string) ( $input[ $field ] ?? '' ) ) ) {
				$missing[] = $field;
			}
		}
		return $missing;
	}

	/** @return list<string> */
	private function string_list( mixed $value ): array {
		if ( is_string( $value ) ) {
			$value = '' === trim( $value ) ? array() : array( $value );
		}
		if ( ! is_array( $value ) ) {
			return array();
		}
		return array_values(
			array_filter(
				array_map( static fn( mixed $item ): string => trim( (string) $item ), $value ),
				static fn( string $item ): bool => '' !== $item
			)
		);
	}

	/** @param array<string,mixed> $extra @return array<string,mixed> */
	private function failure( string $code, string $message, array $extra = array() ): array {
		return array_merge(
			array(
				'success' => false,
				'error'   => array( 'code' => 'wp_codebox_runner_workspace_' . $code, 'message' => $message ),
			),
			$extra
		);
	}

	/** @param array{exit_code:int,stdout:string,stderr:string} $result @return array<string,mixed> */
	private function git_failure( string $operation, array $result ): array {
		return $this->failure(
			'git_failed',
			sprintf( 'git %s failed.', $operation ),
			array(
				'operation' => $operation,
				'exit_code' => $result['exit_code'],
				'stderr'    => trim( $result['stderr'] ),
			)
		);
	}
}

/**
 * JSON-encode helper that prefers wp_json_encode when WordPress is loaded.
 *
 * @param mixed $value
 */
function wp_codebox_runner_workspace_json_encode( $value ): string {
	if ( function_exists( 'wp_json_encode' ) ) {
		$encoded = wp_json_encode( $value );
		return is_string( $encoded ) ? $encoded : '{}';
	}
	$encoded = json_encode( $value );
	return is_string( $encoded ) ? $encoded : '{}';
}
