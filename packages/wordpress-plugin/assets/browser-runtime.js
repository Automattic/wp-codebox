( () => {
	const defaultRunnerDir = '/wordpress/wp-content/uploads/wp-codebox/runner';
	const defaultRunnerUrlBase = '/wp-content/uploads/wp-codebox/runner';
	const browserProviderProxySchema = 'wp-codebox/browser-provider-proxy-request/v1';
	const browserProviderProxyMaxBytes = 1000000;

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

	const runtimeError = ( phase, code, message, data = null ) => {
		const error = new Error( message );
		error.phase = phase;
		error.code = code;
		error.data = data;
		return error;
	};

	const errorDetails = ( error ) => ( {
		code: error?.code || 'runtime_error',
		phase: error?.phase || 'runtime',
		message: error?.message || String( error ),
		data: error?.data ?? null,
	} );

	const normalizePlaygroundAttempt = ( attempt, index, method ) => {
		if ( typeof attempt === 'function' ) {
			return {
				label: `${ method }-${ index + 1 }`,
				run: attempt,
			};
		}

		return {
			label: String( attempt?.label || `${ method }-${ index + 1 }` ),
			run: attempt?.run,
			shape: attempt?.shape || null,
		};
	};

	const invokePlaygroundMethod = async ( phase, method, attempts ) => {
		let lastError = null;
		const failedAttempts = [];
		for ( const [ index, rawAttempt ] of attempts.entries() ) {
			const attempt = normalizePlaygroundAttempt( rawAttempt, index, method );
			try {
				if ( typeof attempt.run !== 'function' ) {
					throw runtimeError( phase, `playground_${ method }_attempt_invalid`, `Playground ${ method } attempt is not callable.` );
				}
				return await attempt.run();
			} catch ( error ) {
				lastError = error;
				failedAttempts.push( {
					label: attempt.label,
					shape: attempt.shape,
					error: errorDetails( error ),
				} );
			}
		}

		throw runtimeError(
			phase,
			`playground_${ method }_failed`,
			`Playground ${ method } failed during ${ phase }.`,
			{
				last_error: lastError ? errorDetails( lastError ) : null,
				attempts: failedAttempts,
			}
		);
	};

	const isPlaygroundStructuredCloneError = ( error ) => {
		const message = String( error?.message || '' );
		if ( error?.code === 25 || message.includes( 'could not be cloned' ) || message.includes( 'DataCloneError' ) ) {
			return true;
		}

		const details = error?.data;
		if ( details?.last_error && isPlaygroundStructuredCloneError( details.last_error ) ) {
			return true;
		}

		return Array.isArray( details?.attempts ) && details.attempts.some( ( attempt ) => isPlaygroundStructuredCloneError( attempt?.error ) );
	};

	const runPhpDirect = async ( client, code, options = {} ) => {
		if ( typeof client?.run !== 'function' ) {
			throw runtimeError( 'run_php', 'playground_run_unavailable', 'Playground run is unavailable.' );
		}

		const response = await invokePlaygroundMethod( 'run_php', 'run', [
			() => client.run( { code } ),
			() => client.run( code ),
		] );
		return options.expectJson ? await parseJsonResponse( response ) : response;
	};

	const redactBrowserProviderProxyData = ( value ) => {
		if ( ! value || typeof value !== 'object' ) {
			return value;
		}

		if ( Array.isArray( value ) ) {
			return value.map( redactBrowserProviderProxyData );
		}

		return Object.fromEntries( Object.entries( value ).map( ( [ key, item ] ) => [
			key,
			/authorization|secret|token|password|credential|private_key|api_key|\bkey\b|\bvalue\b/i.test( key ) ? '[redacted]' : redactBrowserProviderProxyData( item ),
		] ) );
	};

	const browserProviderDiagnostics = () => {
		const diagnostics = window.__wpCodeboxBrowserProviderDiagnostics;
		if ( diagnostics && typeof diagnostics === 'object' ) {
			return diagnostics;
		}

		window.__wpCodeboxBrowserProviderDiagnostics = {
			schema: 'wp-codebox/browser-provider-live-diagnostics/v1',
			requests: [],
			counts: {
				started: 0,
				completed: 0,
				failed: 0,
			},
		};

		return window.__wpCodeboxBrowserProviderDiagnostics;
	};

	const safeJsonParse = ( value ) => {
		if ( typeof value !== 'string' || ! value ) {
			return null;
		}

		try {
			const parsed = JSON.parse( value );
			return parsed && typeof parsed === 'object' ? parsed : null;
		} catch {
			return null;
		}
	};

	const summarizeProviderRequestBody = ( body ) => {
		const parsed = safeJsonParse( typeof body === 'string' ? body : '' );
		if ( ! parsed ) {
			return {};
		}

		const tools = Array.isArray( parsed.tools ) ? parsed.tools : [];
		const input = Array.isArray( parsed.input ) ? parsed.input : [];
		const inputTypes = input.map( ( item ) => typeof item?.type === 'string' ? item.type : ( typeof item?.role === 'string' ? `message:${ item.role }` : '' ) ).filter( Boolean );
		const functionCalls = input.filter( ( item ) => item?.type === 'function_call' );
		const functionOutputs = input.filter( ( item ) => item?.type === 'function_call_output' );
		return {
			model: typeof parsed.model === 'string' ? parsed.model : '',
			previous_response_id: typeof parsed.previous_response_id === 'string' && parsed.previous_response_id ? true : false,
			input_items: input.length,
			input_types: inputTypes.slice( 0, 20 ),
			input_function_call_count: functionCalls.length,
			input_function_call_output_count: functionOutputs.length,
			input_function_call_ids: functionCalls.map( ( item ) => typeof item?.call_id === 'string' ? item.call_id : '' ).filter( Boolean ).slice( 0, 20 ),
			input_function_call_output_ids: functionOutputs.map( ( item ) => typeof item?.call_id === 'string' ? item.call_id : '' ).filter( Boolean ).slice( 0, 20 ),
			tool_count: tools.length,
			tool_names: tools.map( ( tool ) => typeof tool?.name === 'string' ? tool.name : '' ).filter( Boolean ).slice( 0, 20 ),
		};
	};

	const summarizeProviderResponseBody = ( body ) => {
		const parsed = safeJsonParse( typeof body === 'string' ? body : '' );
		if ( ! parsed ) {
			return {};
		}

		const output = Array.isArray( parsed.output ) ? parsed.output : [];
		const functionCalls = output.filter( ( item ) => item?.type === 'function_call' );
		return {
			id_present: typeof parsed.id === 'string' && parsed.id ? true : false,
			status: typeof parsed.status === 'string' ? parsed.status : '',
			output_items: output.length,
			output_types: output.map( ( item ) => typeof item?.type === 'string' ? item.type : '' ).filter( Boolean ).slice( 0, 20 ),
			function_call_count: functionCalls.length,
			function_call_names: functionCalls.map( ( item ) => typeof item?.name === 'string' ? item.name : '' ).filter( Boolean ).slice( 0, 20 ),
			function_call_ids: functionCalls.map( ( item ) => typeof item?.call_id === 'string' ? item.call_id : '' ).filter( Boolean ).slice( 0, 20 ),
			usage: parsed.usage && typeof parsed.usage === 'object' ? {
				input_tokens: Number.isFinite( parsed.usage.input_tokens ) ? parsed.usage.input_tokens : null,
				output_tokens: Number.isFinite( parsed.usage.output_tokens ) ? parsed.usage.output_tokens : null,
				total_tokens: Number.isFinite( parsed.usage.total_tokens ) ? parsed.usage.total_tokens : null,
			} : null,
		};
	};

	const summarizeBrowserProviderProxyMessage = ( message ) => {
		const request = message?.request && typeof message.request === 'object' ? message.request : {};
		return {
			id: typeof message?.id === 'string' ? message.id : '',
			operation: typeof message?.operation === 'string' ? message.operation : '',
			provider: typeof message?.provider === 'string' ? message.provider : '',
			model: typeof message?.model === 'string' ? message.model : '',
			connector_present: typeof message?.connector === 'string' && message.connector ? true : false,
			method: typeof request.method === 'string' ? request.method : '',
			uri: typeof request.uri === 'string' ? request.uri.replace( /[?].*$/, '' ) : '',
			request_bytes: typeof request.body === 'string' ? request.body.length : 0,
			request: summarizeProviderRequestBody( request.body ),
		};
	};

	const summarizeBrowserProviderProxyResponse = ( response ) => {
		const responsePayload = response?.response && typeof response.response === 'object' ? response.response : {};
		const http = responsePayload?.http && typeof responsePayload.http === 'object' ? responsePayload.http : response?.http || {};
		return {
			success: response?.success === true,
			status: Number.isFinite( http?.status ) ? http.status : null,
			response_bytes: typeof http?.body === 'string' ? http.body.length : 0,
			response: summarizeProviderResponseBody( http?.body ),
			error_code: typeof response?.error?.code === 'string' ? response.error.code : '',
		};
	};

	const recordBrowserProviderDiagnostic = ( entry ) => {
		const diagnostics = browserProviderDiagnostics();
		diagnostics.requests.push( entry );
		if ( diagnostics.requests.length > 20 ) {
			diagnostics.requests.splice( 0, diagnostics.requests.length - 20 );
		}
		window.dispatchEvent( new CustomEvent( 'wp-codebox:browser-provider-diagnostic', { detail: entry } ) );
	};

	const browserProviderProxyError = ( code, message, data = {} ) => {
		const redactedData = redactBrowserProviderProxyData( data );
		return {
			success: false,
			error: {
				code,
				message,
				...( redactedData && typeof redactedData === 'object' && ! Array.isArray( redactedData ) ? redactedData : {} ),
			},
		};
	};

	const parseBrowserProviderProxyMessage = ( data ) => {
		const text = typeof data === 'string' ? data : '';
		if ( ! text || text.length > browserProviderProxyMaxBytes ) {
			return null;
		}

		let message = null;
		try {
			message = JSON.parse( text );
		} catch {
			return null;
		}

		return isPlainObject( message ) && message.schema === browserProviderProxySchema ? message : null;
	};

	const browserProviderProxyEndpoint = () => {
		const root = window.wpApiSettings?.root || window.wp?.apiFetch?.root;
		if ( typeof root === 'string' && root ) {
			return new URL( 'wp-codebox/v1/browser-provider-request', root ).toString();
		}

		return new URL( '/wp-json/wp-codebox/v1/browser-provider-request', window.location.origin ).toString();
	};

	const browserProviderProxyHeaders = () => {
		const nonce = window.wpApiSettings?.nonce;
		return {
			'Content-Type': 'application/json',
			...( typeof nonce === 'string' && nonce ? { 'X-WP-Nonce': nonce } : {} ),
		};
	};

	const executeBrowserProviderProxyRequest = async ( message ) => {
		const body = JSON.stringify( message );
		if ( body.length > browserProviderProxyMaxBytes ) {
			return browserProviderProxyError( 'wp_codebox_browser_provider_proxy_payload_too_large', 'Browser provider proxy request is too large.' );
		}

		const startedAt = Date.now();
		const requestSummary = summarizeBrowserProviderProxyMessage( message );
		browserProviderDiagnostics().counts.started += 1;

		try {
			let result;
			if ( window.wp?.apiFetch ) {
				result = await window.wp.apiFetch( {
					path: '/wp-codebox/v1/browser-provider-request',
					method: 'POST',
					data: message,
				} );
				browserProviderDiagnostics().counts.completed += 1;
				recordBrowserProviderDiagnostic( {
					...requestSummary,
					duration_ms: Date.now() - startedAt,
					...summarizeBrowserProviderProxyResponse( result ),
				} );
				return result;
			}

			const response = await fetch( browserProviderProxyEndpoint(), {
				method: 'POST',
				credentials: 'same-origin',
				headers: browserProviderProxyHeaders(),
				body,
			} );
			const json = await response.json().catch( () => null );
			if ( ! response.ok ) {
				const error = browserProviderProxyError( 'wp_codebox_browser_provider_proxy_http_error', 'Browser provider proxy request failed.', { status: response.status, response: json } );
				browserProviderDiagnostics().counts.failed += 1;
				recordBrowserProviderDiagnostic( { ...requestSummary, duration_ms: Date.now() - startedAt, success: false, status: response.status, error_code: error.error.code } );
				return error;
			}

			if ( isPlainObject( json ) ) {
				browserProviderDiagnostics().counts.completed += 1;
				recordBrowserProviderDiagnostic( {
					...requestSummary,
					duration_ms: Date.now() - startedAt,
					...summarizeBrowserProviderProxyResponse( json ),
				} );
				return json;
			}

			const error = browserProviderProxyError( 'wp_codebox_browser_provider_proxy_malformed_response', 'Browser provider proxy returned a malformed response.' );
			browserProviderDiagnostics().counts.failed += 1;
			recordBrowserProviderDiagnostic( { ...requestSummary, duration_ms: Date.now() - startedAt, success: false, error_code: error.error.code } );
			return error;
		} catch ( error ) {
			const proxyError = browserProviderProxyError( 'wp_codebox_browser_provider_proxy_fetch_failed', error?.message || 'Browser provider proxy request failed.' );
			browserProviderDiagnostics().counts.failed += 1;
			recordBrowserProviderDiagnostic( { ...requestSummary, duration_ms: Date.now() - startedAt, success: false, error_code: proxyError.error.code } );
			return proxyError;
		}
	};

	const installBrowserProviderProxy = ( client ) => {
		const onMessage = typeof client?.onMessage === 'function' ? client.onMessage.bind( client ) : null;
		if ( ! onMessage ) {
			return null;
		}

		const remove = onMessage( async ( data ) => {
			const message = parseBrowserProviderProxyMessage( data );
			if ( ! message ) {
				return undefined;
			}

			return JSON.stringify( await executeBrowserProviderProxyRequest( message ) );
		} );

		return async () => {
			const cleanup = await remove;
			if ( typeof cleanup === 'function' ) {
				await cleanup();
			}
		};
	};

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

	const playgroundRequestTarget = ( client ) => {
		if ( client && typeof client.request === 'function' ) {
			return {
				target: client,
				method: client.request,
				shape: 'client',
			};
		}

		if ( client?.requestHandler && typeof client.requestHandler.request === 'function' ) {
			return {
				target: client.requestHandler,
				method: client.requestHandler.request,
				shape: 'request-handler',
			};
		}

		return null;
	};

	const playgroundMkdir = async ( client, path ) => {
		if ( typeof client?.mkdir !== 'function' ) {
			return;
		}

		await invokePlaygroundMethod( 'mkdir', 'mkdir', [
			() => client.mkdir( path, { recursive: true } ),
			() => client.mkdir( path ),
			() => client.mkdir( { path } ),
		] );
	};

	const playgroundWriteFile = async ( client, path, contents ) => {
		if ( typeof client?.writeFile !== 'function' ) {
			throw runtimeError( 'write_file', 'playground_write_file_unavailable', 'Playground writeFile is unavailable.' );
		}

		await invokePlaygroundMethod( 'write_file', 'writeFile', [
			() => client.writeFile( path, contents ),
			() => client.writeFile( { path, data: contents } ),
			() => client.writeFile( { path, contents } ),
		] );
	};

	const playgroundRequest = async ( client, request ) => {
		const requestTarget = playgroundRequestTarget( client );
		if ( ! requestTarget ) {
			throw runtimeError( 'request', 'playground_request_unavailable', 'Playground request handler is unavailable.' );
		}

		const invoke = ( body ) => requestTarget.method.call( requestTarget.target, body );
		const attempts = requestTarget.shape === 'request-handler'
			? [
				{ label: 'request-handler-envelope', shape: 'request-handler', run: () => invoke( { request } ) },
				{ label: 'request-handler-plain', shape: 'request-handler', run: () => invoke( request ) },
			]
			: [
				{ label: 'client-plain', shape: 'client', run: () => invoke( request ) },
				{ label: 'client-envelope', shape: 'client', run: () => invoke( { request } ) },
			];

		return await invokePlaygroundMethod( 'request', 'request', attempts );
	};

	const runPhpRequest = async ( client, options = {} ) => {
		const code = String( options.code || '' );
		if ( ! code ) {
			throw runtimeError( 'validate', 'php_code_missing', 'PHP code is required.' );
		}

		if ( ! options.forceRequest && typeof client.run === 'function' ) {
			return await runPhpDirect( client, code, options );
		}

		const runnerDir = String( options.runnerDir || defaultRunnerDir );
		const runnerUrlBase = String( options.runnerUrlBase || defaultRunnerUrlBase );
		const filename = `${ safeName( options.name ) }-${ Date.now() }-${ Math.random().toString( 36 ).slice( 2, 8 ) }.php`;
		const scriptPath = `${ runnerDir }/${ filename }`;
		const requestUrl = `${ runnerUrlBase }/${ filename }`;
		await playgroundMkdir( client, runnerDir );
		await playgroundWriteFile( client, scriptPath, code );

		const request = {
			method: 'GET',
			url: requestUrl,
		};
		let response;
		try {
			response = await playgroundRequest( client, request );
		} catch ( error ) {
			if ( options.forceRequest && typeof client.run === 'function' && isPlaygroundStructuredCloneError( error ) ) {
				return await runPhpDirect( client, code, options );
			}

			throw error;
		}

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

	const normalizePhpPrelude = ( prelude ) => String( prelude || '' )
		.replace( /^\s*<\?php\s*/i, '' )
		.replace( /\?>\s*$/i, '' );

	const withBrowserRunnerPrelude = ( code, recipe ) => {
		const source = String( code || '' );
		const prelude = recipe?.browser?.runner_contract?.php_prelude;
		if ( typeof prelude !== 'string' || prelude.trim() === '' || source.includes( 'function wp_codebox_browser_artifact_environment' ) ) {
			return source;
		}

		return injectPhpPrelude( source, normalizePhpPrelude( prelude ) );
	};

	const injectPhpPrelude = ( code, prelude ) => {
		const source = String( code || '' );
		if ( source.startsWith( '<?php' ) ) {
			return source.replace( '<?php', `<?php\n${ prelude }` );
		}

		return `<?php\n${ prelude }\n?>\n${ source }`;
	};

	const fanoutAggregationInputSchema = 'wp-codebox/agent-fanout-aggregation-input/v1';
	const fanoutAggregationOutputSchema = 'wp-codebox/agent-fanout-aggregation-output/v1';

	const stableJson = ( value ) => {
		if ( value === null || typeof value !== 'object' ) {
			return JSON.stringify( value ) ?? 'null';
		}
		if ( Array.isArray( value ) ) {
			return `[${ value.map( stableJson ).join( ',' ) }]`;
		}

		return `{${ Object.keys( value ).sort().map( ( key ) => `${ JSON.stringify( key ) }:${ stableJson( value[ key ] ) }` ).join( ',' ) }}`;
	};

	const safeFanoutSegment = ( segment ) => String( segment || '' )
		.replace( /[^a-zA-Z0-9._-]+/g, '-' )
		.replace( /^-+|-+$/g, '' );

	const fanoutOutputNamespace = ( aggregation ) => {
		const raw = typeof aggregation?.outputNamespace === 'string' && aggregation.outputNamespace.trim() !== '' ? aggregation.outputNamespace : 'aggregate/final';
		return raw.split( '/' ).map( safeFanoutSegment ).filter( Boolean ).join( '/' ) || 'aggregate/final';
	};

	const normalizeFanoutWorkerPlan = ( worker ) => ( {
		...( worker && typeof worker === 'object' ? worker : {} ),
		id: typeof worker?.id === 'string' ? worker.id : '',
		dependsOn: Array.isArray( worker?.dependsOn ) ? worker.dependsOn.filter( ( value ) => typeof value === 'string' && value.length > 0 ) : Array.isArray( worker?.depends_on ) ? worker.depends_on.filter( ( value ) => typeof value === 'string' && value.length > 0 ) : [],
		required: worker?.required !== false,
		artifactNamespace: typeof worker?.artifactNamespace === 'string' ? worker.artifactNamespace : typeof worker?.artifact_namespace === 'string' ? worker.artifact_namespace : undefined,
	} );

	const normalizeFanoutArtifactRef = ( artifact, fallbackWorkerId ) => ( {
		id: typeof artifact?.id === 'string' ? artifact.id : undefined,
		path: typeof artifact?.path === 'string' ? artifact.path : '',
		kind: typeof artifact?.kind === 'string' ? artifact.kind : undefined,
		workerId: typeof artifact?.workerId === 'string' ? artifact.workerId : typeof artifact?.worker_id === 'string' ? artifact.worker_id : typeof fallbackWorkerId === 'string' ? fallbackWorkerId : undefined,
		namespace: typeof artifact?.namespace === 'string' ? artifact.namespace : undefined,
		finalPath: typeof artifact?.finalPath === 'string' ? artifact.finalPath : typeof artifact?.final_path === 'string' ? artifact.final_path : undefined,
		contentType: typeof artifact?.contentType === 'string' ? artifact.contentType : typeof artifact?.content_type === 'string' ? artifact.content_type : undefined,
		sha256: typeof artifact?.sha256 === 'string' ? artifact.sha256 : undefined,
		bytes: typeof artifact?.bytes === 'number' ? artifact.bytes : undefined,
		metadata: artifact?.metadata && typeof artifact.metadata === 'object' && ! Array.isArray( artifact.metadata ) ? artifact.metadata : undefined,
	} );

	const normalizeFanoutWorkerResultRef = ( worker ) => {
		const artifactRefs = Array.isArray( worker?.artifactRefs ) ? worker.artifactRefs : Array.isArray( worker?.artifact_refs ) ? worker.artifact_refs : [];
		const workerId = typeof worker?.workerId === 'string' ? worker.workerId : typeof worker?.worker_id === 'string' ? worker.worker_id : '';
		return {
			workerId,
			status: typeof worker?.status === 'string' ? worker.status : 'missing',
			required: worker?.required !== false,
			resultRef: typeof worker?.resultRef === 'string' ? worker.resultRef : typeof worker?.result_ref === 'string' ? worker.result_ref : undefined,
			artifactRefs: artifactRefs.map( ( artifact ) => normalizeFanoutArtifactRef( artifact, workerId ) ),
			...( worker?.error && typeof worker.error === 'object' ? { error: worker.error } : {} ),
			...( worker?.metadata && typeof worker.metadata === 'object' && ! Array.isArray( worker.metadata ) ? { metadata: worker.metadata } : {} ),
		};
	};

	const normalizeFanoutConflict = ( conflict ) => ( {
		type: typeof conflict?.type === 'string' ? conflict.type : 'partial-output',
		severity: typeof conflict?.severity === 'string' ? conflict.severity : 'error',
		message: typeof conflict?.message === 'string' ? conflict.message : 'Fanout aggregation conflict candidate.',
		...( Array.isArray( conflict?.workerIds ) ? { workerIds: conflict.workerIds.filter( ( value ) => typeof value === 'string' && value.length > 0 ) } : Array.isArray( conflict?.worker_ids ) ? { workerIds: conflict.worker_ids.filter( ( value ) => typeof value === 'string' && value.length > 0 ) } : {} ),
		...( typeof conflict?.path === 'string' ? { path: conflict.path } : {} ),
		...( typeof conflict?.dependencyId === 'string' ? { dependencyId: conflict.dependencyId } : typeof conflict?.dependency_id === 'string' ? { dependencyId: conflict.dependency_id } : {} ),
		...( conflict?.details && typeof conflict.details === 'object' && ! Array.isArray( conflict.details ) ? { details: conflict.details } : {} ),
	} );

	const normalizeFanoutAggregationInput = ( input ) => {
		const source = input && typeof input === 'object' ? input : {};
		const workerResultRefs = ( Array.isArray( source.workerResultRefs ) ? source.workerResultRefs : Array.isArray( source.worker_results ) ? source.worker_results : Array.isArray( source.workerResults ) ? source.workerResults : [] ).map( normalizeFanoutWorkerResultRef );
		const directArtifactRefs = ( Array.isArray( source.artifactRefs ) ? source.artifactRefs : Array.isArray( source.artifact_refs ) ? source.artifact_refs : [] ).map( ( artifact ) => normalizeFanoutArtifactRef( artifact ) );
		return {
			schema: fanoutAggregationInputSchema,
			plan: {
				...( source.plan && typeof source.plan === 'object' ? source.plan : {} ),
				workers: ( Array.isArray( source.plan?.workers ) ? source.plan.workers : [] ).map( normalizeFanoutWorkerPlan ),
			},
			policy: typeof source.policy === 'string' ? source.policy : 'fail',
			aggregator: source.aggregator && typeof source.aggregator === 'object' ? source.aggregator : source.aggregation && typeof source.aggregation === 'object' ? source.aggregation : undefined,
			workerResultRefs,
			artifactRefs: [ ...directArtifactRefs, ...workerResultRefs.flatMap( ( worker ) => worker.artifactRefs ) ],
			conflictCandidates: ( Array.isArray( source.conflictCandidates ) ? source.conflictCandidates : Array.isArray( source.conflict_candidates ) ? source.conflict_candidates : [] ).map( normalizeFanoutConflict ),
			...( source.metadata && typeof source.metadata === 'object' && ! Array.isArray( source.metadata ) ? { metadata: source.metadata } : {} ),
		};
	};

	const fanoutAggregationStatus = ( policy, conflicts ) => {
		if ( ! conflicts.some( ( conflict ) => conflict.severity === 'error' ) ) {
			return 'succeeded';
		}
		if ( policy === 'partial' ) {
			return 'partial';
		}
		if ( policy === 'repair' ) {
			return 'repair_required';
		}
		if ( policy === 'caller-review-required' ) {
			return 'caller_review_required';
		}
		return 'failed';
	};

	const fanoutAggregationConflicts = ( input ) => {
		const conflicts = [ ...input.conflictCandidates ];
		const byFinalPath = new Map();
		for ( const ref of input.artifactRefs ) {
			if ( ! ref.finalPath ) {
				continue;
			}
			byFinalPath.set( ref.finalPath, [ ...( byFinalPath.get( ref.finalPath ) || [] ), ref ] );
		}
		for ( const [ path, refs ] of byFinalPath.entries() ) {
			if ( refs.length > 1 ) {
				conflicts.push( {
					type: 'duplicate-final-artifact-path',
					severity: 'error',
					message: `Multiple fanout worker artifacts target final path ${ path }.`,
					path,
					workerIds: [ ...new Set( refs.map( ( ref ) => ref.workerId ).filter( Boolean ) ) ],
					artifactRefs: refs,
				} );
			}
		}

		const resultByWorker = new Map( input.workerResultRefs.map( ( result ) => [ result.workerId, result ] ) );
		for ( const result of input.workerResultRefs ) {
			if ( result.required && result.status !== 'succeeded' ) {
				conflicts.push( {
					type: 'failed-worker',
					severity: 'error',
					message: `Required fanout worker ${ result.workerId } ended with status ${ result.status }.`,
					workerIds: [ result.workerId ],
					artifactRefs: result.artifactRefs,
					...( result.error ? { details: { error: result.error } } : {} ),
				} );
			}
		}
		for ( const worker of input.plan.workers ) {
			for ( const dependencyId of worker.dependsOn ) {
				const dependency = resultByWorker.get( dependencyId );
				if ( ! dependency ) {
					conflicts.push( {
						type: 'missing-worker-dependency',
						severity: 'error',
						message: `Fanout worker ${ worker.id } depends on missing worker ${ dependencyId }.`,
						workerIds: [ worker.id ],
						dependencyId,
					} );
				} else if ( dependency.status !== 'succeeded' ) {
					conflicts.push( {
						type: 'failed-worker-dependency',
						severity: 'error',
						message: `Fanout worker ${ worker.id } depends on ${ dependencyId }, which ended with status ${ dependency.status }.`,
						workerIds: [ worker.id, dependencyId ],
						dependencyId,
						artifactRefs: dependency.artifactRefs,
					} );
				}
			}
		}

		return conflicts;
	};

	const aggregateFanoutOutputs = ( input ) => {
		const normalized = normalizeFanoutAggregationInput( input );
		const outputPath = `${ fanoutOutputNamespace( normalized.aggregator ) }/result.json`;
		const conflicts = fanoutAggregationConflicts( normalized );
		const hasErrors = conflicts.some( ( conflict ) => conflict.severity === 'error' );
		return {
			schema: fanoutAggregationOutputSchema,
			status: fanoutAggregationStatus( normalized.policy, conflicts ),
			policy: normalized.policy,
			plan: normalized.plan,
			aggregator: normalized.aggregator,
			workerResultRefs: normalized.workerResultRefs,
			rawWorkerArtifactRefs: normalized.artifactRefs,
			finalArtifactRefs: hasErrors ? [] : [ { path: outputPath, kind: 'fanout-aggregate-output', contentType: 'application/json' } ],
			conflicts,
			metadata: {
				...( normalized.metadata || {} ),
				events: [ 'fanout.started', 'aggregation.started', 'aggregation.completed', hasErrors ? 'fanout.failed' : 'fanout.completed' ].map( ( event ) => ( { schema: 'wp-codebox/agent-fanout-event/v1', event } ) ),
			},
		};
	};

	const argValue = ( args, name ) => {
		const prefix = `${ name }=`;
		const match = ( args || [] ).find( ( arg ) => typeof arg === 'string' && arg.startsWith( prefix ) );
		return typeof match === 'string' ? match.slice( prefix.length ) : undefined;
	};

	const runFanoutAggregationStep = async ( client, step, payload, options ) => {
		const args = step?.args || [];
		const inputJson = argValue( args, 'input-json' );
		const input = inputJson ? JSON.parse( inputJson ) : payload;
		const output = aggregateFanoutOutputs( input );
		const artifactPath = output.finalArtifactRefs[ 0 ]?.path || `${ fanoutOutputNamespace( output.aggregator ) }/result.json`;
		const targetPath = argValue( args, 'output-path' ) || `/wordpress/wp-content/uploads/wp-codebox/artifacts/${ artifactPath }`;
		const writeResult = await writeFile( client, {
			path: targetPath,
			content: `${ stableJson( output ) }\n`,
		}, {
			name: options.name || 'codebox-fanout-aggregation',
		} );
		if ( ! writeResult.success ) {
			throw runtimeError( 'fanout_aggregation_write', writeResult?.error?.code || 'fanout_aggregation_write_failed', writeResult?.error?.message || 'Fanout aggregation output write failed.', writeResult?.error?.data ?? null );
		}

		return {
			success: output.status === 'succeeded',
			schema: 'wp-codebox/browser-agent-run/v1',
			data: output,
			error: output.status === 'succeeded' ? null : { code: 'fanout_aggregation_failed', message: 'Fanout aggregation reported conflicts.', data: { status: output.status, conflicts: output.conflicts } },
		};
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
			throw runtimeError( 'recipe_validate', 'browser_recipe_missing', 'WP Codebox browser recipe missing.' );
		}

		const payload = taskPayload && typeof taskPayload === 'object' ? taskPayload : recipe?.browser?.task_payload;
		if ( ! payload || typeof payload !== 'object' ) {
			throw runtimeError( 'recipe_validate', 'browser_recipe_task_payload_missing', 'WP Codebox browser recipe task payload missing.' );
		}
		if ( ! recipe?.browser?.runner_contract?.php_prelude && steps.some( ( step ) => ( step?.args || [] ).some( ( arg ) => typeof arg === 'string' && arg.startsWith( 'code=' ) && arg.includes( 'wp_codebox_browser_' ) && ! arg.includes( 'function wp_codebox_browser_artifact_environment' ) ) ) ) {
			throw runtimeError( 'recipe_validate', 'browser_recipe_runner_contract_missing', 'Browser recipe PHP references WP Codebox runner helpers but does not include a runner contract.' );
		}

		const writeResult = await writeFile( client, {
			path: taskPath,
			content: JSON.stringify( payload ),
		}, {
			name: options.name || 'codebox-recipe-task',
		} );
		if ( ! writeResult.success ) {
			throw runtimeError( 'recipe_task_write', writeResult?.error?.code || 'browser_recipe_task_write_failed', writeResult?.error?.message || 'WP Codebox browser recipe task write failed.', writeResult?.error?.data ?? null );
		}

		let lastResult = null;
		const removeProviderProxy = installBrowserProviderProxy( client );
		try {
			for ( const step of steps ) {
				if ( step?.command === 'wp-codebox.agent-fanout-aggregate' ) {
					lastResult = await runFanoutAggregationStep( client, step, payload, options );
					if ( ! lastResult.success ) {
						throw runtimeError( 'recipe_step_fanout_aggregation', lastResult?.error?.code || 'browser_recipe_fanout_aggregation_failed', lastResult?.error?.message || 'WP Codebox browser fanout aggregation failed.', lastResult?.error?.data ?? null );
					}
					continue;
				}

				if ( step?.command !== 'wordpress.run-php' ) {
					throw runtimeError( 'recipe_step_validate', 'browser_recipe_step_unsupported', `Unsupported browser recipe step: ${ step?.command || 'unknown' }`, { command: step?.command || null } );
				}

				const codeArg = ( step.args || [] ).find( ( arg ) => typeof arg === 'string' && arg.startsWith( 'code=' ) );
				if ( ! codeArg ) {
					throw runtimeError( 'recipe_step_validate', 'browser_recipe_php_code_missing', 'Browser recipe PHP step missing code argument.' );
				}

				lastResult = await runPhpRequest( client, {
					...options,
					code: markBrowserPlaygroundRunner( withBrowserRunnerPrelude( codeArg.slice( 5 ), recipe ) ),
					name: options.name || 'codebox-recipe',
					expectJson: true,
					forceRequest: true,
				} );
				if ( ! lastResult.success ) {
					throw runtimeError( 'recipe_step_php', lastResult?.error?.code || 'browser_recipe_step_failed', lastResult?.error?.message || 'WP Codebox browser recipe step failed.', lastResult?.error?.data ?? null );
				}
			}
		} finally {
			await removeProviderProxy?.();
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

	const browserRuntimeContractPhase = async ( phases, name, callback ) => {
		const startedAt = Date.now();
		try {
			const data = await callback();
			const phase = {
				name,
				status: 'passed',
				duration_ms: Date.now() - startedAt,
				...( data && typeof data === 'object' ? { data } : {} ),
			};
			phases.push( phase );
			return phase;
		} catch ( error ) {
			const phase = {
				name,
				status: 'failed',
				duration_ms: Date.now() - startedAt,
				error: {
					code: error?.code || 'phase_failed',
					message: error?.message || String( error ),
				},
			};
			phases.push( phase );
			return phase;
		}
	};

	const requireProbeSuccess = ( result, message ) => {
		if ( ! result?.success ) {
			throw new Error( result?.error?.message || message );
		}

		return result.data ?? null;
	};

	const withEchoBrowserProviderBridge = async ( callback ) => {
		const previousWp = window.wp;
		const previousApiFetch = window.wp?.apiFetch;
		window.wp = window.wp && typeof window.wp === 'object' ? window.wp : {};
		window.wp.apiFetch = async ( request ) => ( {
			success: true,
			response: {
				schema: 'wp-codebox/browser-provider-adapter-response/v1',
				http: {
					status: 200,
					body: JSON.stringify( {
						id: 'wp-codebox-contract-probe-response',
						status: 'completed',
						output: [
							{
								type: 'message',
								role: 'assistant',
								content: [ { type: 'output_text', text: 'echo' } ],
							},
						],
					} ),
				},
			},
			audit: {
				schema: 'wp-codebox/browser-provider-audit/v1',
				operation: request?.data?.operation || 'responses.create',
			},
		} );

		try {
			return await callback();
		} finally {
			if ( previousWp === undefined ) {
				delete window.wp;
			} else {
				window.wp = previousWp;
				if ( previousApiFetch === undefined && window.wp && typeof window.wp === 'object' ) {
					delete window.wp.apiFetch;
				} else if ( window.wp && typeof window.wp === 'object' ) {
					window.wp.apiFetch = previousApiFetch;
				}
			}
		}
	};

	const runBrowserRuntimeContractProbe = async ( client, options = {} ) => {
		const phases = [];
		const artifactRoot = String( options.artifactRoot || '/wordpress/wp-content/uploads/wp-codebox/artifacts/contract-probe' );
		const artifactFile = `${ artifactRoot.replace( /\/$/, '' ) }/tool-output.txt`;
		const probeText = 'wp-codebox-browser-runtime-contract-probe';

		await browserRuntimeContractPhase( phases, 'runtime-bootstrap', async () => {
			const functions = [ 'runPhpRequest', 'runRecipe', 'runBrowserSessionRecipe', 'runWordPressOperation', 'writeFile' ];
			const missing = functions.filter( ( name ) => typeof window.wpCodeboxBrowser?.[ name ] !== 'function' );
			if ( missing.length > 0 ) {
				throw new Error( `Missing browser runtime functions: ${ missing.join( ', ' ) }` );
			}

			return { schema: 'wp-codebox/browser-runtime-contract-phase/v1', functions };
		} );

		await browserRuntimeContractPhase( phases, 'php-execution', async () => {
			const result = await runPhpRequest( client, {
				code: "<?php echo wp_json_encode( array( 'success' => true, 'data' => array( 'phase' => 'php-execution' ), 'error' => null ) );",
				expectJson: true,
				name: 'codebox-contract-php-execution',
			} );
			if ( true !== result?.success ) {
				throw new Error( 'PHP execution did not return success.' );
			}

			return { phase: result.data?.phase || '' };
		} );

		await browserRuntimeContractPhase( phases, 'playground-request-handler', async () => {
			const result = await runPhpRequest( client, {
				code: "<?php echo wp_json_encode( array( 'success' => true, 'data' => array( 'phase' => 'playground-request-handler' ), 'error' => null ) );",
				expectJson: true,
				forceRequest: true,
				name: 'codebox-contract-request-handler',
			} );
			if ( true !== result?.success ) {
				throw new Error( 'Playground request handler did not return success.' );
			}

			return { phase: result.data?.phase || '' };
		} );

		await browserRuntimeContractPhase( phases, 'runner-file-write-read', async () => {
			const path = '/tmp/wp-codebox-contract-probe.txt';
			requireProbeSuccess( await writeFile( client, { path, content: probeText }, { name: 'codebox-contract-file-write' } ), 'Runner file write failed.' );
			const result = await runPhpRequest( client, {
				code: `<?php $path = ${ JSON.stringify( path ) }; echo wp_json_encode( array( 'success' => is_readable( $path ), 'data' => array( 'path' => $path, 'sha256' => is_readable( $path ) ? hash( 'sha256', file_get_contents( $path ) ) : '' ), 'error' => null ) );`,
				expectJson: true,
				forceRequest: true,
				name: 'codebox-contract-file-read',
			} );
			if ( true !== result?.success ) {
				throw new Error( 'Runner file read failed.' );
			}

			return { path, sha256: result.data?.sha256 || '' };
		} );

		await browserRuntimeContractPhase( phases, 'provider-bridge-echo', async () => withEchoBrowserProviderBridge( async () => {
			const result = await executeBrowserProviderProxyRequest( {
				schema: browserProviderProxySchema,
				id: 'wp-codebox-contract-probe-provider-request',
				operation: 'responses.create',
				provider: 'echo',
				model: 'echo-probe',
				connector: 'contract-probe',
				request: {
					method: 'POST',
					uri: '/v1/responses',
					body: JSON.stringify( { model: 'echo-probe', input: [ { role: 'user', content: 'echo' } ], tools: [] } ),
				},
			} );
			if ( true !== result?.success ) {
				throw new Error( result?.error?.message || 'Echo browser provider bridge failed.' );
			}

			const diagnostics = browserProviderDiagnostics();
			return {
				provider: 'echo',
				status: result.response?.http?.status ?? null,
				diagnostic_count: diagnostics.requests.length,
			};
		} ) );

		await browserRuntimeContractPhase( phases, 'runtime-tool-artifact-write', async () => {
			const data = requireProbeSuccess( await writeFile( client, { path: artifactFile, content: probeText }, { name: 'codebox-contract-artifact-write' } ), 'Artifact write failed.' );
			return { path: data?.path || artifactFile, bytes: data?.bytes ?? null };
		} );

		await browserRuntimeContractPhase( phases, 'artifact-capture', async () => {
			const result = await runPhpRequest( client, {
				code: `<?php $path = ${ JSON.stringify( artifactFile ) }; $exists = is_readable( $path ); echo wp_json_encode( array( 'success' => $exists, 'data' => array( 'schema' => 'wp-codebox/browser-runtime-contract-artifact-capture/v1', 'files' => $exists ? array( array( 'path' => basename( $path ), 'sha256' => hash( 'sha256', file_get_contents( $path ) ), 'size' => filesize( $path ) ) ) : array() ), 'error' => $exists ? null : array( 'code' => 'artifact_missing', 'message' => 'Probe artifact was not readable.' ) ) );`,
				expectJson: true,
				forceRequest: true,
				name: 'codebox-contract-artifact-capture',
			} );
			if ( true !== result?.success ) {
				throw new Error( result?.error?.message || 'Artifact capture failed.' );
			}

			return result.data;
		} );

		await browserRuntimeContractPhase( phases, 'generated-runner-artifact-capture', async () => {
			const recipeTaskPath = '/tmp/wp-codebox-contract-recipe-task.json';
			const result = await runRecipe( client, {
				browser: {
					task_path: recipeTaskPath,
					runner_contract: {
						schema: 'wp-codebox/browser-runner-contract/v1',
						php_prelude: `<?php
function wp_codebox_browser_artifact_environment( array $payload ): array {
$contract = is_array( $payload['artifacts'] ?? null ) ? $payload['artifacts'] : array();
$root = rtrim( (string) ( $contract['root'] ?? 'wp-codebox-output' ), '/' ) . '/';
return array( 'contract' => $contract, 'root' => $root );
}
function wp_codebox_browser_capture_artifact_bundle( array $payload ): array {
return is_array( $payload['artifacts'] ?? null ) ? $payload['artifacts'] : array();
}`,
					},
				},
				workflow: {
					steps: [
						{
							command: 'wordpress.run-php',
							args: [ `code=<?php
$payload = array();
if ( is_readable( '${ recipeTaskPath }' ) ) {
	$raw_payload = json_decode( (string) file_get_contents( '${ recipeTaskPath }' ), true );
	if ( is_array( $raw_payload ) ) {
		$payload = $raw_payload;
	}
}
$environment = wp_codebox_browser_artifact_environment( $payload );
$artifact_bundle = wp_codebox_browser_capture_artifact_bundle( $payload );
echo wp_json_encode( array(
	'success' => ! empty( $environment ) && ! empty( $artifact_bundle ),
	'data' => array(
		'schema' => 'wp-codebox/browser-runtime-contract-generated-runner/v1',
		'root' => $environment['root'] ?? '',
		'artifact_schema' => $artifact_bundle['schema'] ?? '',
		'file_count' => is_array( $artifact_bundle['files'] ?? null ) ? count( $artifact_bundle['files'] ) : 0,
	),
	'error' => null,
) );` ],
						},
					],
				},
			}, {
				artifacts: {
					schema: 'wp-codebox/browser-runtime-contract-generated-artifact/v1',
					root: 'contract-generated',
					entrypoint: 'contract-generated/index.html',
					files: [
						{
							path: 'contract-generated/index.html',
							playground_path: '/wordpress/wp-content/uploads/wp-codebox/artifacts/contract-generated/index.html',
							kind: 'html',
							mime_type: 'text/html',
						},
					],
				},
			}, { name: 'codebox-contract-generated-runner' } );

			if ( true !== result?.success ) {
				throw new Error( result?.error?.message || 'Generated browser runner artifact capture failed.' );
			}

			return result.data;
		} );

		await browserRuntimeContractPhase( phases, 'fanout-aggregation-phase', async () => {
			const result = await runRecipe( client, {
				browser: {
					task_path: '/tmp/wp-codebox-contract-fanout-aggregation-input.json',
				},
				workflow: {
					steps: [
						{
							command: 'wp-codebox.agent-fanout-aggregate',
							args: [],
						},
					],
				},
			}, {
				schema: fanoutAggregationInputSchema,
				plan: {
					id: 'contract-fanout',
					workers: [
						{ id: 'worker-a', artifact_namespace: 'fanout/workers/worker-a' },
						{ id: 'worker-b', depends_on: [ 'worker-a' ], artifact_namespace: 'fanout/workers/worker-b' },
					],
				},
				policy: 'fail',
				aggregation: {
					outputNamespace: 'aggregate/final',
				},
				worker_results: [
					{
						worker_id: 'worker-a',
						status: 'succeeded',
						artifact_refs: [ { path: 'fanout/workers/worker-a/result.json', final_path: 'worker-a/result.json' } ],
					},
					{
						worker_id: 'worker-b',
						status: 'succeeded',
						artifact_refs: [ { path: 'fanout/workers/worker-b/result.json', final_path: 'worker-b/result.json' } ],
					},
				],
			}, { name: 'codebox-contract-fanout-aggregation' } );

			if ( true !== result?.success || result?.data?.schema !== fanoutAggregationOutputSchema ) {
				throw new Error( result?.error?.message || 'Fanout aggregation phase did not return the aggregation output contract.' );
			}

			return {
				schema: result.data.schema,
				status: result.data.status,
				final_path: result.data.finalArtifactRefs?.[ 0 ]?.path || '',
				worker_results: result.data.workerResultRefs?.length || 0,
			};
		} );

		await browserRuntimeContractPhase( phases, 'event-diagnostics', async () => {
			const diagnostics = browserProviderDiagnostics();
			return {
				schema: diagnostics.schema,
				provider_requests: diagnostics.requests.length,
				bounded: diagnostics.requests.length <= 20,
				failed_phases: phases.filter( ( phase ) => phase.status !== 'passed' ).map( ( phase ) => phase.name ),
			};
		} );

		const failed = phases.filter( ( phase ) => phase.status !== 'passed' );
		return {
			schema: 'wp-codebox/browser-runtime-contract-probe/v1',
			success: failed.length === 0,
			status: failed.length === 0 ? 'passed' : 'failed',
			phases,
			errors: failed.map( ( phase ) => ( {
				phase: phase.name,
				...( phase.error || {} ),
			} ) ),
		};
	};

	window.wpCodeboxBrowser = {
		activateTheme,
		browserSessionRecipe,
		ensureDirectory,
		installTheme,
		normalizeOperationResult,
		parseJsonResponse,
		runBrowserRuntimeContractProbe,
		runBrowserSessionRecipe,
		runPhpRequest,
		runRecipe,
		runWordPressOperation,
		setFrontendAdminBarVisible,
		writeFile,
		writeReviewFile,
	};
} )();
