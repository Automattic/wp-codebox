( () => {
	const defaultRunnerDir = '/wordpress/wp-content/uploads/wp-codebox/runner';
	const defaultRunnerUrlBase = '/wp-content/uploads/wp-codebox/runner';

	const safeName = ( name ) => String( name || 'task' ).replace( /[^a-z0-9_-]/gi, '-' ).toLowerCase();

	const responseText = async ( response ) => {
		if ( typeof response === 'string' ) {
			return response;
		}

		if ( typeof response?.text === 'string' ) {
			return response.text;
		}

		if ( typeof response?.text === 'function' ) {
			return await response.text();
		}

		for ( const field of [ 'stdout', 'output', 'body' ] ) {
			if ( typeof response?.[ field ] === 'string' ) {
				return response[ field ];
			}
		}

		if ( ArrayBuffer.isView( response?.bytes ) || Array.isArray( response?.bytes ) ) {
			return new TextDecoder().decode( new Uint8Array( response.bytes ) );
		}

		return '';
	};

	const parseJsonResponse = async ( response ) => {
		const text = await responseText( response );
		const start = text.indexOf( '{' );
		const end = text.lastIndexOf( '}' );
		if ( start === -1 || end === -1 || end < start ) {
			const keys = response && typeof response === 'object' ? Object.keys( response ).join( ',' ) : typeof response;
			const status = response && typeof response === 'object' ? ` httpStatusCode: ${ response.httpStatusCode ?? 'n/a' }. exitCode: ${ response.exitCode ?? 'n/a' }.` : '';
			const errors = response?.errors === undefined ? '' : ` Response errors: ${ JSON.stringify( response.errors ).slice( 0, 500 ) }.`;
			throw new Error( `WP Codebox browser runner did not return JSON. Response keys: ${ keys }.${ status }${ errors } Response preview: ${ text.slice( 0, 500 ) }` );
		}

		return JSON.parse( text.slice( start, end + 1 ) );
	};

	const base64Json = ( value ) => {
		const bytes = new TextEncoder().encode( JSON.stringify( value ) );
		let binary = '';
		for ( let offset = 0; offset < bytes.length; offset += 0x8000 ) {
			binary += String.fromCharCode( ...bytes.subarray( offset, offset + 0x8000 ) );
		}

		return btoa( binary );
	};

	const normalizeOperationResult = ( result ) => {
		if ( ! result || typeof result !== 'object' ) {
			return {
				success: false,
				error: {
					code: 'invalid_response',
					message: 'WP Codebox browser operation returned an invalid response.',
				},
			};
		}

		if ( result.success ) {
			return {
				success: true,
				data: result.data ?? null,
			};
		}

		return {
			success: false,
			error: {
				code: result?.error?.code || 'operation_failed',
				message: result?.error?.message || 'WP Codebox browser operation failed.',
				data: result?.error?.data ?? null,
			},
		};
	};

	const siteOperationEnvelope = ( operation, result, meta = {} ) => {
		const errors = result?.success === false ? [ result.error ].filter( Boolean ) : [];
		const success = result?.success === true;
		return {
			operation,
			success,
			status: success ? 'ok' : 'error',
			...meta,
			data: success ? result.data ?? null : null,
			errors,
		};
	};

	const siteOperationValidationError = ( operation, message, meta = {} ) => siteOperationEnvelope( operation, {
		success: false,
		error: {
			code: 'invalid_args',
			message,
			data: null,
		},
	}, meta );

	const isSafeRelativePath = ( path ) => {
		if ( typeof path !== 'string' || '' === path || path.startsWith( '/' ) || path.includes( '\\' ) ) {
			return false;
		}

		return path.split( '/' ).every( ( part ) => part && part !== '.' && part !== '..' );
	};

	const isPlainObject = ( value ) => !! value && typeof value === 'object' && ! Array.isArray( value );

const operationPhp = ( operation ) => `<?php
header( 'Content-Type: application/json; charset=utf-8' );

if ( ! defined( 'ABSPATH' ) ) {
	$wp_load = '/wordpress/wp-load.php';
	if ( ! file_exists( $wp_load ) ) {
		$wp_load = dirname( __DIR__, 4 ) . '/wp-load.php';
	}
	if ( ! file_exists( $wp_load ) ) {
		$wp_load = rtrim( $_SERVER['DOCUMENT_ROOT'] ?? '', '/' ) . '/wp-load.php';
	}

	if ( file_exists( $wp_load ) ) {
		require_once $wp_load;
	}
}

$operation = json_decode( base64_decode( '${ base64Json( operation ) }' ), true );

if ( ! is_array( $operation ) ) {
	wp_codebox_browser_operation_response( false, null, array(
		'code' => 'invalid_operation',
		'message' => 'Browser operation payload must be an object.',
	) );
}

function wp_codebox_browser_operation_response( $success, $data = null, $error = null ) {
	echo wp_json_encode( array(
		'success' => (bool) $success,
		'data' => $data,
		'error' => $error,
	) );
	exit;
}

function wp_codebox_browser_operation_arg( $operation, $key, $default = null ) {
	$args = isset( $operation['args'] ) && is_array( $operation['args'] ) ? $operation['args'] : array();
	return array_key_exists( $key, $args ) ? $args[ $key ] : $default;
}

function wp_codebox_browser_operation_path( $path ) {
	$path = is_string( $path ) ? $path : '';
	if ( '' === $path ) {
		throw new InvalidArgumentException( 'Path is required.' );
	}

	if ( '/' === $path[0] ) {
		return $path;
	}

	return ABSPATH . ltrim( $path, '/' );
}

function wp_codebox_browser_operation_mkdir( $path ) {
	if ( is_dir( $path ) ) {
		return;
	}

	if ( ! wp_mkdir_p( $path ) && ! is_dir( $path ) ) {
		throw new RuntimeException( sprintf( 'Unable to create directory: %s', $path ) );
	}
}

function wp_codebox_browser_operation_file_content( $content, $encoding ) {
	if ( ! is_string( $content ) ) {
		throw new InvalidArgumentException( 'File content must be a string.' );
	}

	if ( 'base64' === $encoding ) {
		$decoded = base64_decode( $content, true );
		if ( false === $decoded ) {
			throw new InvalidArgumentException( 'Base64 file content is invalid.' );
		}
		return $decoded;
	}

	if ( 'utf8' !== $encoding && 'utf-8' !== $encoding ) {
		throw new InvalidArgumentException( sprintf( 'Unsupported file encoding: %s', $encoding ) );
	}

	return $content;
}

function wp_codebox_browser_operation_theme_file_path( $theme_dir, $relative_path ) {
	if ( ! is_string( $relative_path ) || '' === $relative_path || '/' === $relative_path[0] ) {
		throw new InvalidArgumentException( 'Theme file paths must be relative.' );
	}

	$parts = explode( '/', str_replace( chr( 92 ), '/', $relative_path ) );
	foreach ( $parts as $part ) {
		if ( '' === $part || '.' === $part || '..' === $part ) {
			throw new InvalidArgumentException( sprintf( 'Invalid theme file path: %s', $relative_path ) );
		}
	}

	return trailingslashit( $theme_dir ) . implode( '/', $parts );
}

function wp_codebox_browser_operation_safe_relative_path( $relative_path, $label ) {
	if ( ! is_string( $relative_path ) || '' === $relative_path || '/' === $relative_path[0] ) {
		throw new InvalidArgumentException( sprintf( '%s path must be relative.', $label ) );
	}

	$parts = explode( '/', str_replace( chr( 92 ), '/', $relative_path ) );
	foreach ( $parts as $part ) {
		if ( '' === $part || '.' === $part || '..' === $part ) {
			throw new InvalidArgumentException( sprintf( 'Invalid %s path: %s', $label, $relative_path ) );
		}
	}

	return implode( '/', $parts );
}

try {
	$type = isset( $operation['type'] ) && is_string( $operation['type'] ) ? $operation['type'] : '';

	switch ( $type ) {
		case 'setFrontendAdminBarVisible':
			$visible = wp_codebox_browser_operation_arg( $operation, 'visible' );
			if ( ! is_bool( $visible ) ) {
				throw new InvalidArgumentException( 'Admin bar visibility must be a boolean.' );
			}

			$user_id = (int) wp_codebox_browser_operation_arg( $operation, 'userId', 0 );
			if ( $user_id <= 0 ) {
				$users = get_users( array(
					'role__in' => array( 'administrator' ),
					'number' => 1,
					'fields' => 'ID',
				) );
				$user_id = isset( $users[0] ) ? (int) $users[0] : 1;
			}

			$user = get_user_by( 'id', $user_id );
			if ( ! $user ) {
				throw new RuntimeException( sprintf( 'User does not exist: %d', $user_id ) );
			}

			$value = $visible ? 'true' : 'false';
			update_user_meta( $user_id, 'show_admin_bar_front', $value );
			wp_codebox_browser_operation_response( true, array(
				'target' => 'frontendAdminBar',
				'key' => 'show_admin_bar_front',
				'userId' => $user_id,
				'visible' => $visible,
				'value' => $value,
			) );
			break;

		case 'writeReviewFile':
			$relative_path = wp_codebox_browser_operation_safe_relative_path( wp_codebox_browser_operation_arg( $operation, 'path' ), 'Review file' );
			$content = wp_codebox_browser_operation_arg( $operation, 'content', '' );
			$encoding = wp_codebox_browser_operation_arg( $operation, 'encoding', 'utf8' );
			$content = wp_codebox_browser_operation_file_content( $content, $encoding );

			$upload_dir = wp_upload_dir();
			if ( empty( $upload_dir['basedir'] ) ) {
				throw new RuntimeException( 'Upload directory is unavailable.' );
			}

			$base_dir = trailingslashit( $upload_dir['basedir'] ) . 'wp-codebox/reviews';
			$path = trailingslashit( $base_dir ) . $relative_path;
			wp_codebox_browser_operation_mkdir( dirname( $path ) );
			$bytes = file_put_contents( $path, $content );
			if ( false === $bytes ) {
				throw new RuntimeException( sprintf( 'Unable to write review file: %s', $relative_path ) );
			}

			wp_codebox_browser_operation_response( true, array(
				'target' => 'reviewFile',
				'path' => $path,
				'relativePath' => $relative_path,
				'bytes' => $bytes,
			) );

		case 'ensureDirectory':
			$path = wp_codebox_browser_operation_path( wp_codebox_browser_operation_arg( $operation, 'path' ) );
			wp_codebox_browser_operation_mkdir( $path );
			wp_codebox_browser_operation_response( true, array(
				'path' => $path,
				'exists' => is_dir( $path ),
			) );

		case 'writeFile':
			$path = wp_codebox_browser_operation_path( wp_codebox_browser_operation_arg( $operation, 'path' ) );
			$content = wp_codebox_browser_operation_arg( $operation, 'content', '' );
			$encoding = wp_codebox_browser_operation_arg( $operation, 'encoding', 'utf8' );
			$content = wp_codebox_browser_operation_file_content( $content, $encoding );

			wp_codebox_browser_operation_mkdir( dirname( $path ) );
			$bytes = file_put_contents( $path, $content );
			if ( false === $bytes ) {
				throw new RuntimeException( sprintf( 'Unable to write file: %s', $path ) );
			}

			wp_codebox_browser_operation_response( true, array(
				'path' => $path,
				'bytes' => $bytes,
			) );

		case 'installTheme':
			$slug = wp_codebox_browser_operation_arg( $operation, 'slug' );
			$files = wp_codebox_browser_operation_arg( $operation, 'files' );
			$activate = (bool) wp_codebox_browser_operation_arg( $operation, 'activate', false );
			if ( ! is_string( $slug ) || '' === $slug || sanitize_key( $slug ) !== $slug ) {
				throw new InvalidArgumentException( 'Theme slug must be a non-empty sanitized key.' );
			}

			if ( ! is_array( $files ) || array() === $files ) {
				throw new InvalidArgumentException( 'Theme files must be a non-empty object.' );
			}

			$theme_dir = trailingslashit( get_theme_root() ) . $slug;
			wp_codebox_browser_operation_mkdir( $theme_dir );
			$written = array();

			foreach ( $files as $relative_path => $file ) {
				$file = is_array( $file ) ? $file : array( 'content' => $file );
				$target = wp_codebox_browser_operation_theme_file_path( $theme_dir, $relative_path );
				$content = wp_codebox_browser_operation_file_content( $file['content'] ?? '', $file['encoding'] ?? 'utf8' );
				wp_codebox_browser_operation_mkdir( dirname( $target ) );
				$bytes = file_put_contents( $target, $content );
				if ( false === $bytes ) {
					throw new RuntimeException( sprintf( 'Unable to write theme file: %s', $relative_path ) );
				}
				$written[] = array(
					'path' => $relative_path,
					'bytes' => $bytes,
				);
			}

			$theme = wp_get_theme( $slug );
			if ( ! $theme->exists() ) {
				throw new RuntimeException( sprintf( 'Installed theme is invalid: %s', $slug ) );
			}

			if ( $activate ) {
				switch_theme( $slug );
			}

			wp_codebox_browser_operation_response( true, array(
				'slug' => $slug,
				'name' => $theme->get( 'Name' ),
				'activated' => $activate,
				'files' => $written,
			) );

		case 'activateTheme':
			$slug = wp_codebox_browser_operation_arg( $operation, 'slug' );
			if ( ! is_string( $slug ) || '' === $slug ) {
				throw new InvalidArgumentException( 'Theme slug is required.' );
			}

			$theme = wp_get_theme( $slug );
			if ( ! $theme->exists() ) {
				throw new RuntimeException( sprintf( 'Theme does not exist: %s', $slug ) );
			}

			switch_theme( $slug );
			wp_codebox_browser_operation_response( true, array(
				'slug' => $slug,
				'name' => $theme->get( 'Name' ),
			) );

		default:
			throw new InvalidArgumentException( sprintf( 'Unsupported browser operation: %s', $type ?: 'unknown' ) );
	}
} catch ( Throwable $throwable ) {
	wp_codebox_browser_operation_response( false, null, array(
		'code' => 'operation_failed',
		'message' => $throwable->getMessage(),
		'data' => array(
			'type' => get_class( $throwable ),
		),
	) );
}
`;

	const playgroundRequestHandler = ( client ) => {
		if ( client?.requestHandler && typeof client.requestHandler.request === 'function' ) {
			return client.requestHandler;
		}

		if ( client && typeof client.request === 'function' ) {
			return client;
		}

		return null;
	};

	const runPhpRequest = async ( client, options = {} ) => {
		const requestHandler = playgroundRequestHandler( client );
		if ( ! requestHandler ) {
			throw new Error( 'Playground request handler is unavailable.' );
		}

		const code = String( options.code || '' );
		if ( ! code ) {
			throw new Error( 'PHP code is required.' );
		}

		if ( ! options.forceRequest && typeof client.run === 'function' ) {
			const response = await client.run( { code } );
			return options.expectJson ? await parseJsonResponse( response ) : response;
		}

		const runnerDir = String( options.runnerDir || defaultRunnerDir );
		const runnerUrlBase = String( options.runnerUrlBase || defaultRunnerUrlBase );
		const filename = `${ safeName( options.name ) }-${ Date.now() }-${ Math.random().toString( 36 ).slice( 2, 8 ) }.php`;
		const scriptPath = `${ runnerDir }/${ filename }`;
		const requestUrl = `${ runnerUrlBase }/${ filename }`;

		if ( typeof client.mkdir === 'function' ) {
			await client.mkdir( runnerDir );
		}
		await client.writeFile( scriptPath, code );

		const response = await requestHandler.request( {
			method: 'GET',
			url: requestUrl,
		} );

		return options.expectJson ? await parseJsonResponse( response ) : response;
	};

	const runWordPressOperation = async ( client, operation, options = {} ) => {
		if ( ! operation || typeof operation !== 'object' || typeof operation.type !== 'string' ) {
			throw new Error( 'WordPress browser operation must include a type.' );
		}

		const result = await runPhpRequest( client, {
			...options,
			code: operationPhp( operation ),
			name: options.name || `codebox-${ operation.type }`,
			expectJson: true,
		} );

		return normalizeOperationResult( result );
	};

	const ensureDirectory = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'ensureDirectory',
		args,
	}, options );

	const writeFile = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'writeFile',
		args,
	}, options );

	const activateTheme = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'activateTheme',
		args,
	}, options );

	const installTheme = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'installTheme',
		args,
	}, options );

	const setFrontendAdminBarVisible = async ( client, args = {}, options = {} ) => {
		const operation = 'setFrontendAdminBarVisible';
		const meta = {
			target: 'frontendAdminBar',
			key: 'show_admin_bar_front',
		};
		if ( ! isPlainObject( args ) ) {
			return siteOperationValidationError( operation, 'Admin bar operation args must be an object.', meta );
		}

		if ( typeof args?.visible !== 'boolean' ) {
			return siteOperationValidationError( operation, 'Admin bar visibility must be a boolean.', meta );
		}

		if ( args.userId !== undefined && ( ! Number.isInteger( args.userId ) || args.userId <= 0 ) ) {
			return siteOperationValidationError( operation, 'Admin bar userId must be a positive integer when provided.', meta );
		}

		const result = await runWordPressOperation( client, {
			type: operation,
			args,
		}, options );

		return siteOperationEnvelope( operation, result, meta );
	};

	const writeReviewFile = async ( client, args = {}, options = {} ) => {
		const operation = 'writeReviewFile';
		const meta = {
			target: 'reviewFile',
			path: args?.path ?? null,
		};
		if ( ! isPlainObject( args ) ) {
			return siteOperationValidationError( operation, 'Review file operation args must be an object.', meta );
		}

		if ( ! isSafeRelativePath( args?.path ) ) {
			return siteOperationValidationError( operation, 'Review file path must be a safe relative path.', meta );
		}

		if ( typeof args?.content !== 'string' ) {
			return siteOperationValidationError( operation, 'Review file content must be a string.', meta );
		}

		if ( args.encoding !== undefined && args.encoding !== 'utf8' && args.encoding !== 'utf-8' && args.encoding !== 'base64' ) {
			return siteOperationValidationError( operation, 'Review file encoding must be utf8 or base64.', meta );
		}

		const result = await runWordPressOperation( client, {
			type: operation,
			args,
		}, options );

		return siteOperationEnvelope( operation, result, {
			...meta,
			path: result?.data?.path ?? args.path,
		} );
	};

	const markBrowserPlaygroundRunner = ( code ) => {
		const marker = "define( 'WP_CODEBOX_BROWSER_PLAYGROUND_RUNNER', true );";
		const source = String( code || '' );
		if ( source.startsWith( '<?php' ) ) {
			return source.replace( '<?php', `<?php\n${ marker }` );
		}

		return `<?php\n${ marker }\n?>\n${ source }`;
	};

	const browserSessionRecipe = ( session ) => {
		if ( ! session || typeof session !== 'object' ) {
			throw new Error( 'WP Codebox browser session output is required.' );
		}

		if ( session.schema && session.schema !== 'wp-codebox/browser-playground-session/v1' ) {
			throw new Error( `Unsupported WP Codebox browser session schema: ${ session.schema }` );
		}

		if ( session.success === false || session.status === 'blocked' ) {
			throw new Error( session?.error?.message || 'WP Codebox browser session is not ready.' );
		}

		const recipe = session.recipe && typeof session.recipe === 'object' ? session.recipe : null;
		if ( ! recipe ) {
			throw new Error( 'WP Codebox browser session is missing a recipe.' );
		}

		return recipe;
	};

	const runRecipe = async ( client, recipe, taskPayload, options = {} ) => {
		const taskPath = recipe?.browser?.task_path;
		const steps = Array.isArray( recipe?.workflow?.steps ) ? recipe.workflow.steps : [];
		if ( ! taskPath || steps.length === 0 ) {
			throw new Error( 'WP Codebox browser recipe missing.' );
		}

		const payload = taskPayload && typeof taskPayload === 'object' ? taskPayload : recipe?.browser?.task_payload;
		if ( ! payload || typeof payload !== 'object' ) {
			throw new Error( 'WP Codebox browser recipe task payload missing.' );
		}

		const writeResult = await writeFile( client, {
			path: taskPath,
			content: JSON.stringify( payload ),
		}, {
			name: options.name || 'codebox-recipe-task',
		} );
		if ( ! writeResult.success ) {
			throw new Error( writeResult?.error?.message || 'WP Codebox browser recipe task write failed.' );
		}

		let lastResult = null;
		for ( const step of steps ) {
			if ( step?.command !== 'wordpress.run-php' ) {
				throw new Error( `Unsupported browser recipe step: ${ step?.command || 'unknown' }` );
			}

			const codeArg = ( step.args || [] ).find( ( arg ) => typeof arg === 'string' && arg.startsWith( 'code=' ) );
			if ( ! codeArg ) {
				throw new Error( 'Browser recipe PHP step missing code argument.' );
			}

			lastResult = await runPhpRequest( client, {
				...options,
				code: markBrowserPlaygroundRunner( codeArg.slice( 5 ) ),
				name: options.name || 'codebox-recipe',
				expectJson: true,
			} );
			if ( ! lastResult.success ) {
				const detail = lastResult?.error?.data ? ` ${ JSON.stringify( lastResult.error.data ) }` : '';
				throw new Error( `${ lastResult?.error?.message || 'WP Codebox browser recipe step failed.' }${ detail }` );
			}
		}

		return lastResult;
	};

	const runBrowserSessionRecipe = async ( client, session, taskPayload, options = {} ) => {
		const recipe = browserSessionRecipe( session );
		const payload = taskPayload === undefined ? ( session.task_payload ?? session.task_input ?? {} ) : taskPayload;
		return runRecipe( client, recipe, payload, {
			...options,
			name: options.name || 'codebox-browser-session',
		} );
	};

	window.wpCodeboxBrowser = {
		activateTheme,
		browserSessionRecipe,
		ensureDirectory,
		installTheme,
		normalizeOperationResult,
		parseJsonResponse,
		runBrowserSessionRecipe,
		runPhpRequest,
		runRecipe,
		runWordPressOperation,
		setFrontendAdminBarVisible,
		writeFile,
		writeReviewFile,
	};
} )();
