( () => {
	const defaultRunnerDir = '/wordpress/wp-content/uploads/wp-codebox/runner';
	const defaultRunnerUrlBase = '/wp-content/uploads/wp-codebox/runner';
	const browserConnectorRequestSchema = 'wp-codebox/browser-connector-request/v1';
	const browserProviderProxySchema = 'wp-codebox/browser-provider-proxy-request/v1';
	const browserProviderProxyMaxBytes = 1000000;
	const browserSdkSchema = 'wp-codebox/browser-sdk/v1';
	const browserSdkResultSchema = 'wp-codebox/browser-sdk-result/v1';
	const browserSdkVersion = '1.0.0';
	const browserSdkCapabilities = Object.freeze( [
		'browser-runtime:info',
		'browser-runtime:normalize-error',
		'browser-runtime:normalize-result',
		'browser-runtime:normalize-browser-run-result',
		'runtime-task:create-request',
		'runtime-task:run',
		'browser-preview:start',
		'browser-contained-site-sync:consume',
		'browser-runtime:boot-executable-session',
		'browser-runtime:parent-tool-bridge',
		'browser-runtime:aggregate-fanout-outputs',
		'browser-runtime:invoke-result',
		'browser-connector:request',
		'playground:run-php',
		'playground:run-recipe',
		'browser-runtime:validate-materialization',
		'wordpress:operation',
		'filesystem:write-file',
		'filesystem:ensure-directory',
		'review:write-file',
		'contract:probe',
	] );

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

	const browserConnectorRequest = ( input = {} ) => {
		const source = isPlainObject( input ) ? input : {};
		const session = isPlainObject( source.session ) ? source.session : Object.fromEntries( Object.entries( {
			sandbox_session_id: typeof source.sandbox_session_id === 'string' ? source.sandbox_session_id : undefined,
			session_id: typeof source.session_id === 'string' ? source.session_id : undefined,
			caller_session_id: typeof source.caller_session_id === 'string' ? source.caller_session_id : undefined,
			job_id: typeof source.job_id === 'string' ? source.job_id : undefined,
		} ).filter( ( [ , item ] ) => item !== undefined && item !== '' ) );
		const payload = isPlainObject( source.payload ) ? source.payload : ( isPlainObject( source.request ) ? source.request : {} );
		return Object.fromEntries( Object.entries( {
			schema: browserConnectorRequestSchema,
			id: typeof source.id === 'string' && source.id ? source.id : undefined,
			connector: typeof source.connector === 'string' ? source.connector : '',
			provider: typeof source.provider === 'string' ? source.provider : '',
			model: typeof source.model === 'string' ? source.model : '',
			operation: typeof source.operation === 'string' ? source.operation : '',
			payload,
			session,
			context: isPlainObject( source.context ) ? source.context : {},
			authorization: isPlainObject( source.authorization ) ? source.authorization : {},
		} ).filter( ( [ key, item ] ) => key === 'schema' || item !== undefined && item !== '' && ( ! isPlainObject( item ) || Object.keys( item ).length > 0 ) ) );
	};

	const browserProviderProxyRequest = ( input = {} ) => {
		const source = isPlainObject( input ) ? input : {};
		const connectorRequest = browserConnectorRequest( source );
		const session = isPlainObject( connectorRequest.session ) ? connectorRequest.session : {};
		const context = isPlainObject( connectorRequest.context ) ? connectorRequest.context : {};
		return Object.fromEntries( Object.entries( {
			schema: browserProviderProxySchema,
			id: connectorRequest.id,
			operation: connectorRequest.operation,
			provider: connectorRequest.provider,
			model: connectorRequest.model,
			connector: connectorRequest.connector,
			inherit: isPlainObject( source.inherit ) ? source.inherit : undefined,
			sandbox_session_id: session.sandbox_session_id || session.session_id || context.sandbox_session_id || context.session_id,
			session_id: session.session_id || context.session_id,
			caller_session_id: session.caller_session_id || context.caller_session_id,
			job_id: session.job_id || context.job_id,
			orchestrator: isPlainObject( context.orchestrator ) ? context.orchestrator : ( isPlainObject( source.orchestrator ) ? source.orchestrator : undefined ),
			authorization: connectorRequest.authorization,
			request: connectorRequest.payload,
		} ).filter( ( [ key, item ] ) => key === 'schema' || item !== undefined && item !== '' && ( ! isPlainObject( item ) || Object.keys( item ).length > 0 ) ) );
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

	const normalizeBrowserSdkError = ( error, fallbackCode = 'runtime_error' ) => {
		const details = errorDetails( error );
		return {
			schema: 'wp-codebox/browser-sdk-error/v1',
			code: details.code || fallbackCode,
			message: details.message || 'WP Codebox browser SDK operation failed.',
			phase: details.phase || 'runtime',
			status: error?.status ?? error?.httpStatusCode ?? null,
			data: details.data,
		};
	};

	const browserSdkResult = async ( operation, callback ) => {
		try {
			return {
				schema: browserSdkResultSchema,
				operation,
				success: true,
				data: await callback(),
				error: null,
			};
		} catch ( error ) {
			return {
				schema: browserSdkResultSchema,
				operation,
				success: false,
				data: null,
				error: normalizeBrowserSdkError( error ),
			};
		}
	};

	const normalizeBrowserArtifactDigest = ( value ) => {
		if ( typeof value === 'string' && value ) {
			return { algorithm: 'sha256', value };
		}
		if ( ! isPlainObject( value ) ) {
			return null;
		}
		const digestValue = typeof value.value === 'string' && value.value ? value.value : null;
		return digestValue ? { algorithm: value.algorithm || 'sha256', value: digestValue } : normalizeBrowserArtifactDigest( value.sha256 || value.digest || value.contentDigest || value.content_digest );
	};

	const normalizeBrowserArtifactRef = ( artifact, defaults = {} ) => {
		if ( ! isPlainObject( artifact ) ) {
			return null;
		}
		const ref = {
			kind: artifact.kind || artifact.artifact_type || artifact.role || defaults.kind || 'artifact',
			id: artifact.id || artifact.artifact_id || artifact.artifactId || defaults.id || undefined,
			path: artifact.path || artifact.artifacts_path || artifact.artifactsPath || artifact.directory || defaults.path || undefined,
			digest: normalizeBrowserArtifactDigest( artifact.digest || artifact.sha256 || artifact.contentDigest || artifact.content_digest ) || defaults.digest || undefined,
		};
		if ( ! ref.id && ! ref.path && ! ref.digest && ! artifact.kind && ! artifact.artifact_type && ! artifact.role ) {
			return null;
		}
		return Object.fromEntries( Object.entries( ref ).filter( ( [ , item ] ) => item !== undefined && item !== null ) );
	};

	const normalizeBrowserArtifactRefs = ( artifacts ) => {
		const refs = [];
		const seen = new Set();
		for ( const artifact of Array.isArray( artifacts ) ? artifacts : [] ) {
			const ref = normalizeBrowserArtifactRef( artifact );
			if ( ! ref ) {
				continue;
			}
			const key = `${ ref.kind }\u0000${ ref.id || '' }\u0000${ ref.path || '' }\u0000${ ref.digest?.algorithm || '' }\u0000${ ref.digest?.value || '' }`;
			if ( seen.has( key ) ) {
				continue;
			}
			seen.add( key );
			refs.push( ref );
		}
		return refs;
	};

	const browserArtifactPersistenceRef = ( input ) => {
		const source = input?.schema === 'wp-codebox/materialization-result/v1' && isPlainObject( input.result ) ? input.result : ( isPlainObject( input?.result ) && ( input.result.artifact || input.result.artifacts || input.result.artifact_bundle || input.result.artifactBundle || input.result.materialization ) ? input.result : input || {} );
		const artifactBundle = isPlainObject( source.artifact_bundle ) ? source.artifact_bundle : ( isPlainObject( source.artifactBundle ) ? source.artifactBundle : null );
		const artifact = isPlainObject( source.artifact ) ? source.artifact : null;
		const artifacts = Array.isArray( source.artifacts ) ? source.artifacts.filter( isPlainObject ) : ( artifact ? [ artifact ] : [] );
		const materialization = isPlainObject( source.materialization ) ? source.materialization : null;
		const existingRefs = normalizeBrowserArtifactRefs( source.artifactRefs );
		const refs = [];
		refs.push( ...existingRefs );
		const bundleRef = normalizeBrowserArtifactRef( artifactBundle, { kind: 'artifact-bundle' } );
		if ( bundleRef ) {
			refs.push( bundleRef );
		}
		for ( const item of artifacts ) {
			const ref = normalizeBrowserArtifactRef( item, { kind: 'browser-artifact' } );
			if ( ref?.path || ref?.id ) {
				refs.push( ref );
			}
		}
		if ( materialization?.id || materialization?.artifact_id ) {
			refs.push( { kind: 'materialization', id: materialization.id || materialization.artifact_id } );
		}
		const seen = new Set();
		const artifactRefs = refs.filter( ( ref ) => {
			const key = `${ ref.kind }\u0000${ ref.id || '' }\u0000${ ref.path || '' }\u0000${ ref.digest?.algorithm || '' }\u0000${ ref.digest?.value || '' }`;
			if ( seen.has( key ) ) {
				return false;
			}
			seen.add( key );
			return true;
		} );

		return {
			schema: 'wp-codebox/browser-artifact-persistence/ref/v1',
			...( artifact ? { artifact } : {} ),
			artifacts,
			...( artifactBundle ? { artifactBundle } : {} ),
			...( materialization ? { materialization } : {} ),
			artifactRefs,
		};
	};

	const normalizeBrowserRunStatus = ( value, success ) => {
		if ( value === 'completed' || value === 'failed' || value === 'skipped' ) {
			return value;
		}
		return success === false ? 'failed' : 'completed';
	};

	const normalizeBrowserRunDiagnostics = ( diagnostics ) => ( Array.isArray( diagnostics ) ? diagnostics
		.filter( ( diagnostic ) => isPlainObject( diagnostic ) && typeof diagnostic.code === 'string' && typeof diagnostic.message === 'string' )
		.map( ( diagnostic ) => Object.fromEntries( Object.entries( {
			code: diagnostic.code,
			message: diagnostic.message,
			severity: [ 'info', 'warning', 'error' ].includes( diagnostic.severity ) ? diagnostic.severity : undefined,
			phase: typeof diagnostic.phase === 'string' ? diagnostic.phase : undefined,
			metadata: isPlainObject( diagnostic.metadata ) ? diagnostic.metadata : undefined,
		} ).filter( ( [ , item ] ) => item !== undefined ) ) ) : [] );

	const normalizeBrowserRunResult = ( result, operation = 'browser-run' ) => {
		if ( result?.schema === 'wp-codebox/browser-run-result/v1' ) {
			const status = normalizeBrowserRunStatus( result.status, result.success );
			const success = status === 'completed';
			const payload = isPlainObject( result.result ) ? result.result : null;
			const artifactRefs = normalizeBrowserArtifactRefs( result.artifactRefs );
			return Object.fromEntries( Object.entries( {
				schema: 'wp-codebox/browser-run-result/v1',
				operation: typeof result.operation === 'string' && result.operation ? result.operation : operation,
				status,
				success,
				result: success ? ( payload || {} ) : payload,
				artifactRefs: artifactRefs.length ? artifactRefs : browserArtifactPersistenceRef( payload || result ).artifactRefs,
				diagnostics: normalizeBrowserRunDiagnostics( result.diagnostics ),
				metadata: isPlainObject( result.metadata ) ? result.metadata : undefined,
				error: status === 'failed' ? normalizeBrowserSdkError( result.error || new Error( 'Browser run failed.' ) ) : undefined,
				reason: status === 'skipped' && typeof result.reason === 'string' ? result.reason : undefined,
			} ).filter( ( [ , item ] ) => item !== undefined ) );
		}
		const payload = isPlainObject( result?.result ) ? result.result : ( isPlainObject( result?.data ) ? result.data : ( isPlainObject( result?.response ) ? result.response : ( isPlainObject( result ) ? result : null ) ) );
		const success = result?.success === true || payload?.success === true;
		const status = success ? 'completed' : ( result?.status === 'skipped' ? 'skipped' : 'failed' );
		return {
			schema: 'wp-codebox/browser-run-result/v1',
			operation,
			status,
			success,
			result: payload,
			artifactRefs: browserArtifactPersistenceRef( payload || result ).artifactRefs,
			diagnostics: [],
			...( success ? {} : { error: normalizeBrowserSdkError( result?.error || payload?.error || new Error( 'Browser run failed.' ) ) } ),
		};
	};

	const browserSdkInfo = () => ( {
		schema: browserSdkSchema,
		apiVersion: 'v1',
		version: browserSdkVersion,
		capabilities: [ ...browserSdkCapabilities ],
		globals: {
			name: 'wpCodeboxBrowser',
			facade: 'wpCodeboxBrowser.v1',
		},
	} );

	const runtimeTaskRestEndpoint = () => {
		const root = window.wpApiSettings?.root || window.wp?.apiFetch?.root;
		if ( typeof root === 'string' && root ) {
			return new URL( 'wp-codebox/v1/runtime-task', root ).toString();
		}

		return new URL( '/wp-json/wp-codebox/v1/runtime-task', window.location.origin ).toString();
	};

	const codeboxRestHeaders = () => {
		const nonce = window.wpApiSettings?.nonce;
		return {
			'Content-Type': 'application/json',
			...( typeof nonce === 'string' && nonce ? { 'X-WP-Nonce': nonce } : {} ),
		};
	};

	const createRuntimeTaskRequest = ( input = {}, defaults = {} ) => {
		const source = isPlainObject( input ) ? input : { task: input };
		const fallback = isPlainObject( defaults ) ? defaults : {};
		const targetId = source.target_id || source.targetId || fallback.target_id || fallback.targetId;
		const task = source.task ?? fallback.task;
		if ( typeof targetId !== 'string' || ! targetId.trim() ) {
			throw runtimeError( 'runtime_task_request', 'runtime_task_target_id_required', 'Runtime task requests require an explicit target_id.' );
		}
		if ( ! isPlainObject( task ) && ( typeof task !== 'string' || ! task.trim() ) ) {
			throw runtimeError( 'runtime_task_request', 'runtime_task_required', 'Runtime task requests require a task string or object.' );
		}

		const request = {
			...( isPlainObject( fallback ) ? fallback : {} ),
			...source,
			schema: 'wp-codebox/runtime-task-request/v1',
			target_id: targetId.trim(),
			task,
		};
		delete request.targetId;

		return request;
	};

	const runRuntimeTask = async ( input = {}, options = {} ) => {
		const request = input?.schema === 'wp-codebox/runtime-task-request/v1' ? input : createRuntimeTaskRequest( input, options.defaults || {} );
		if ( typeof options.executeRuntimeTask === 'function' ) {
			return options.executeRuntimeTask( request );
		}
		if ( typeof options.executeAbility === 'function' ) {
			return options.executeAbility( 'wp-codebox/run-runtime-task', request );
		}
		if ( window.wp?.apiFetch ) {
			return window.wp.apiFetch( {
				path: '/wp-codebox/v1/runtime-task',
				method: 'POST',
				data: request,
			} );
		}
		if ( typeof fetch !== 'function' ) {
			throw runtimeError( 'runtime_task_run', 'runtime_task_fetch_unavailable', 'Browser fetch or wp.apiFetch is required to run runtime tasks.' );
		}

		const response = await fetch( runtimeTaskRestEndpoint(), {
			method: 'POST',
			credentials: 'same-origin',
			headers: codeboxRestHeaders(),
			body: JSON.stringify( request ),
		} );
		const data = await response.json().catch( () => null );
		if ( ! response.ok ) {
			throw runtimeError( 'runtime_task_run', data?.code || 'runtime_task_request_failed', data?.message || 'Runtime task request failed.', { status: response.status, response: data } );
		}

		return data;
	};

	const containedSiteSyncRoute = ( delegation, name ) => {
		const route = String( delegation?.routes?.[ name ] || '' );
		if ( ! route.startsWith( '/' ) || route.startsWith( '//' ) ) {
			throw runtimeError( 'browser_contained_site_sync_consume', 'browser_contained_site_sync_route_invalid', `Contained-site sync route is missing or invalid: ${ name }` );
		}

		return route;
	};

	const fetchContainedSiteSyncRoute = async ( route, method = 'GET', body = null ) => {
		if ( typeof fetch !== 'function' ) {
			throw runtimeError( 'browser_contained_site_sync_consume', 'browser_contained_site_sync_fetch_unavailable', 'Browser fetch is required to consume contained-site sync DTOs.' );
		}

		const response = await fetch( route, {
			method,
			credentials: 'same-origin',
			headers: body ? { 'Content-Type': 'application/json' } : {},
			body: body ? JSON.stringify( body ) : undefined,
		} );
		const data = await response.json().catch( () => null );
		if ( ! response.ok ) {
			throw runtimeError( 'browser_contained_site_sync_consume', 'browser_contained_site_sync_request_failed', data?.message || `Contained-site sync ${ method } ${ route } failed.`, { status: response.status, route } );
		}

		return data;
	};

	const consumeContainedSiteSync = async ( client, delegation, options = {} ) => {
		void client;
		const projectId = Number( options.projectId || options.project_id || 0 );
		const schema = String( delegation?.schema || '' );
		if ( schema !== 'wp-codebox/browser-contained-site-sync-delegation/v1' ) {
			return {
				schema: 'wp-codebox/browser-contained-site-sync-consumption/v1',
				status: 'unavailable',
				project_id: projectId,
				manifest: null,
				resources: null,
				package: null,
				apply_plan: null,
				validation: null,
				validation_hash: '',
				hydration: {
					status: 'not_attempted',
					reason: 'No contained-site sync delegation descriptor was provided.',
				},
			};
		}

		const evidence = {
			schema: 'wp-codebox/browser-contained-site-sync-consumption/v1',
			status: 'running',
			project_id: projectId,
			manifest: delegation.manifest || null,
			resources: null,
			package: null,
			apply_plan: null,
			validation: null,
			validation_hash: '',
			hydration: { status: 'not_attempted' },
		};

		try {
			if ( delegation.routes?.source_connect ) {
				evidence.source = await fetchContainedSiteSyncRoute( containedSiteSyncRoute( delegation, 'source_connect' ), 'POST', {
					project_id: projectId,
				} );
			}
			const manifestRoute = containedSiteSyncRoute( delegation, 'manifest' );
			const exportRoute = containedSiteSyncRoute( delegation, 'export' );
			evidence.manifest = await fetchContainedSiteSyncRoute( manifestRoute );
			if ( delegation.routes?.resources ) {
				evidence.resources = await fetchContainedSiteSyncRoute( containedSiteSyncRoute( delegation, 'resources' ) );
			}
			evidence.package = await fetchContainedSiteSyncRoute( exportRoute, 'POST', {} );
			const syncPackage = evidence.package?.package && typeof evidence.package.package === 'object' ? evidence.package.package : evidence.package;

			if ( delegation.routes?.apply_plan_generate && delegation.routes?.apply_plan_validate ) {
				try {
					evidence.apply_plan = await fetchContainedSiteSyncRoute( containedSiteSyncRoute( delegation, 'apply_plan_generate' ), 'POST', {
						mode: 'content_only',
						package: syncPackage,
						resources: evidence.resources,
					} );
					evidence.validation = await fetchContainedSiteSyncRoute( containedSiteSyncRoute( delegation, 'apply_plan_validate' ), 'POST', {
						mode: 'content_only',
						apply_plan: evidence.apply_plan?.apply_plan || evidence.apply_plan,
						base_snapshot: syncPackage?.base_snapshot || null,
					} );
					evidence.validation_hash = evidence.validation?.validation_hash || evidence.validation?.hash || '';
				} catch ( error ) {
					evidence.validation = {
						status: 'unavailable',
						reason: error?.message || 'Contained-site sync apply-plan validation is unavailable.',
					};
				}
			}

			evidence.hydration = syncPackage?.descriptor?.bootable === true && syncPackage?.blueprint && typeof syncPackage.blueprint === 'object'
				? { status: 'ready', mode: 'blueprint_descriptor', base_snapshot: syncPackage.base_snapshot || null, descriptor: syncPackage.descriptor || null }
				: { status: 'unsupported', reason: 'Contained-site sync export did not include a bootable package descriptor.' };
			evidence.status = evidence.hydration.status === 'ready' ? 'success' : 'unsupported';
		} catch ( error ) {
			evidence.status = 'failed';
			evidence.hydration = {
				status: 'failed',
				reason: error?.message || 'Contained-site sync consumption failed.',
			};
		}

		return evidence;
	};

	const browserPreviewBootConfig = ( input ) => {
		const boot = input?.schema === 'wp-codebox/browser-preview-boot-config/v1'
			? input
			: ( input?.preview_boot && typeof input.preview_boot === 'object' ? input.preview_boot : ( input?.boot && typeof input.boot === 'object' ? input.boot : null ) );
		if ( ! boot || typeof boot !== 'object' ) {
			throw runtimeError( 'browser_preview_start', 'browser_preview_boot_missing', 'A WP Codebox browser preview boot config is required.' );
		}
		if ( boot.schema && boot.schema !== 'wp-codebox/browser-preview-boot-config/v1' && boot.schema !== 'wp-codebox/browser-contained-site-boot/v1' ) {
			throw runtimeError( 'browser_preview_start', 'browser_preview_boot_schema_unsupported', `Unsupported WP Codebox browser preview boot schema: ${ boot.schema }` );
		}

		return boot;
	};

	const hydrateBrowserPreviewBlueprint = async ( boot, options = {} ) => {
		if ( options.blueprint && typeof options.blueprint === 'object' ) {
			return options.blueprint;
		}
		if ( boot.blueprint && typeof boot.blueprint === 'object' ) {
			return boot.blueprint;
		}

		const blueprintRef = boot.blueprint_ref_dto && typeof boot.blueprint_ref_dto === 'object'
			? boot.blueprint_ref_dto
			: ( boot.blueprint_ref && typeof boot.blueprint_ref === 'object' ? boot.blueprint_ref : { ref: boot.blueprint_ref || '' } );
		const ref = String( blueprintRef.ref || blueprintRef.id || boot.blueprint_ref || '' );
		if ( ! ref || ref === 'inline-session-blueprint' ) {
			throw runtimeError( 'browser_preview_start', 'browser_preview_blueprint_ref_missing', 'Browser preview boot config is missing a hydratable Codebox blueprint ref.' );
		}

		const request = {
			schema: 'wp-codebox/browser-blueprint-ref-hydration-request/v1',
			ability: blueprintRef.hydrator_ability || boot.hydrator_ability || 'wp-codebox/hydrate-browser-blueprint-ref',
			ref,
			blueprint_ref: blueprintRef,
			session_id: boot.session_id || '',
		};
		let hydrated;
		if ( typeof options.hydrateBlueprintRef === 'function' ) {
			hydrated = await options.hydrateBlueprintRef( request, boot );
		} else if ( typeof fetch === 'function' && ( blueprintRef.hydration_endpoint || boot.hydration_endpoint ) ) {
			const endpoint = new URL( blueprintRef.hydration_endpoint || boot.hydration_endpoint, window.location.href );
			endpoint.searchParams.set( 'ref', ref );
			hydrated = await fetch( endpoint.toString(), {
				method: 'GET',
				headers: options.nonce ? { 'X-WP-Nonce': String( options.nonce ) } : {},
			} ).then( async ( response ) => {
				const data = await response.json();
				if ( ! response.ok ) {
					throw runtimeError( 'browser_preview_start', 'browser_preview_blueprint_hydration_failed', data?.message || 'Browser preview blueprint hydration failed.', data );
				}
				return data;
			} );
		} else {
			throw runtimeError( 'browser_preview_start', 'browser_preview_blueprint_hydrator_missing', 'Provide hydrateBlueprintRef, an inline blueprint, or a blueprint ref hydration endpoint.' );
		}

		const blueprint = hydrated?.blueprint && typeof hydrated.blueprint === 'object'
			? hydrated.blueprint
			: ( hydrated?.data?.blueprint && typeof hydrated.data.blueprint === 'object' ? hydrated.data.blueprint : hydrated );
		if ( ! blueprint || typeof blueprint !== 'object' || ! Array.isArray( blueprint.steps ) ) {
			throw runtimeError( 'browser_preview_start', 'browser_preview_blueprint_invalid', 'Codebox blueprint hydration did not return an executable Playground blueprint.' );
		}

		return blueprint;
	};

	const resolveStartPlaygroundWeb = async ( boot, options = {} ) => {
		if ( typeof options.startPlaygroundWeb === 'function' ) {
			return options.startPlaygroundWeb;
		}

		const moduleUrl = String( options.clientModuleUrl || boot.client_module_url || '' );
		if ( ! moduleUrl ) {
			throw runtimeError( 'browser_preview_start', 'browser_preview_client_module_missing', 'Browser preview boot config is missing client_module_url; pass startPlaygroundWeb for test or custom hosts.' );
		}

		const importModule = typeof options.importModule === 'function' ? options.importModule : ( async ( url ) => import( url ) );
		const module = await importModule( moduleUrl );
		if ( typeof module?.startPlaygroundWeb !== 'function' ) {
			throw runtimeError( 'browser_preview_start', 'browser_preview_start_unavailable', 'Codebox browser preview client module does not export startPlaygroundWeb.' );
		}

		return module.startPlaygroundWeb;
	};

	const startBrowserPreview = async ( input, options = {} ) => {
		const boot = browserPreviewBootConfig( input );
		const startPlaygroundWeb = await resolveStartPlaygroundWeb( boot, options );
		const blueprint = await hydrateBrowserPreviewBlueprint( boot, options );
		const iframe = options.iframe || input?.iframe || ( typeof document !== 'undefined' && options.iframeSelector ? document.querySelector( options.iframeSelector ) : null );
		const request = {
			...( options.startOptions && typeof options.startOptions === 'object' ? options.startOptions : {} ),
			...( iframe ? { iframe } : {} ),
			...( boot.remote_url ? { remoteUrl: boot.remote_url } : {} ),
			...( boot.cors_proxy_url ? { corsProxyUrl: boot.cors_proxy_url } : {} ),
			...( boot.scope ? { scope: boot.scope } : {} ),
			blueprint,
		};
		const client = await startPlaygroundWeb( request );

		if ( typeof options.onClientConnected === 'function' ) {
			options.onClientConnected( client );
		}

		return {
			schema: 'wp-codebox/browser-preview-start-result/v1',
			success: true,
			status: 'started',
			session_id: boot.session_id || '',
			preview: boot.preview || null,
			boot,
			request: {
				remoteUrl: request.remoteUrl || null,
				corsProxyUrl: request.corsProxyUrl || null,
				scope: request.scope || null,
				hasIframe: !! request.iframe,
				hasBlueprint: !! request.blueprint,
			},
			client,
		};
	};

	const browserSdkFacade = ( api ) => Object.freeze( {
		schema: browserSdkSchema,
		apiVersion: 'v1',
		version: browserSdkVersion,
		capabilities: () => browserSdkInfo().capabilities,
		getCapabilities: () => browserSdkInfo(),
		info: browserSdkInfo,
		normalizeError: normalizeBrowserSdkError,
		normalizeBrowserRunResult,
		browserArtifactPersistenceRef,
		createRuntimeTaskRequest,
		runRuntimeTask,
		consumeContainedSiteSync: ( client, delegation, options = {} ) => api.consumeContainedSiteSync( client, delegation, options ),
		startBrowserPreview: ( input, options = {} ) => api.startBrowserPreview( input, options ),
		aggregateFanoutOutputs: ( input ) => api.aggregateFanoutOutputs( input ),
		validateBrowserRuntimeMaterialization: ( client, session, options = {} ) => api.validateBrowserRuntimeMaterialization( client, session, options ),
		ensureDirectory: ( client, args = {}, options = {} ) => api.ensureDirectory( client, args, options ),
		writeFile: ( client, args = {}, options = {} ) => api.writeFile( client, args, options ),
		readFile: ( client, args = {}, options = {} ) => api.readFile( client, args, options ),
		listDirectory: ( client, args = {}, options = {} ) => api.listDirectory( client, args, options ),
		grep: ( client, args = {}, options = {} ) => api.grep( client, args, options ),
		editFile: ( client, args = {}, options = {} ) => api.editFile( client, args, options ),
		applyPatch: ( client, args = {}, options = {} ) => api.applyPatch( client, args, options ),
		runRecipe: ( client, recipe, taskPayload, options = {} ) => api.runRecipe( client, recipe, taskPayload, options ),
		normalizeResult: normalizeOperationResult,
		result: browserSdkResult,
		executableBrowserSession: api.executableBrowserSession,
		bootExecutableBrowserSession: async ( client, session, options = {} ) => normalizeBrowserRunResult( await api.bootExecutableBrowserSession( client, session, options ), 'browser-executable-session' ),
		parentToolBridge: api.parentToolBridge,
		createBrowserConnectorRequest: api.createBrowserConnectorRequest,
		executeBrowserConnectorRequest: api.executeBrowserConnectorRequest,
		createParentToolRequest: api.createParentToolRequest,
		dispatchParentTool: api.dispatchParentTool,
		runBrowserSessionRecipe: async ( client, session, taskPayload, options = {} ) => normalizeBrowserRunResult( await api.runBrowserSessionRecipe( client, session, taskPayload, options ), 'browser-session-recipe' ),
		setFrontendAdminBarVisible: api.setFrontendAdminBarVisible,
		methods: Object.freeze( {
			activateTheme: api.activateTheme,
			browserSessionRecipe: api.browserSessionRecipe,
			createBrowserConnectorRequest: api.createBrowserConnectorRequest,
			executeBrowserConnectorRequest: api.executeBrowserConnectorRequest,
			executeBrowserProviderProxyRequest: api.executeBrowserProviderProxyRequest,
			consumeContainedSiteSync: api.consumeContainedSiteSync,
			startBrowserPreview: api.startBrowserPreview,
			bootExecutableBrowserSession: api.bootExecutableBrowserSession,
			createParentToolRequest: api.createParentToolRequest,
			dispatchParentTool: api.dispatchParentTool,
			ensureDirectory: api.ensureDirectory,
			readFile: api.readFile,
			listDirectory: api.listDirectory,
			grep: api.grep,
			editFile: api.editFile,
			applyPatch: api.applyPatch,
			executableBrowserSession: api.executableBrowserSession,
			installTheme: api.installTheme,
			parentToolBridge: api.parentToolBridge,
			validateBrowserRuntimeMaterialization: api.validateBrowserRuntimeMaterialization,
			aggregateFanoutOutputs: api.aggregateFanoutOutputs,
			preparedBrowserRuntimeContract: api.preparedBrowserRuntimeContract,
			preparedBrowserRuntimeStatus: api.preparedBrowserRuntimeStatus,
			runBrowserRuntimeContractProbe: api.runBrowserRuntimeContractProbe,
			runBrowserSessionRecipe: api.runBrowserSessionRecipe,
			runPhpRequest: api.runPhpRequest,
			runRecipe: api.runRecipe,
			runWordPressOperation: api.runWordPressOperation,
			selectPreparedBrowserBlueprint: api.selectPreparedBrowserBlueprint,
			setFrontendAdminBarVisible: api.setFrontendAdminBarVisible,
			writeFile: api.writeFile,
			writeReviewFile: api.writeReviewFile,
		} ),
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

		if ( isPlainObject( message ) && message.schema === browserConnectorRequestSchema ) {
			return browserProviderProxyRequest( message );
		}

		return isPlainObject( message ) && message.schema === browserProviderProxySchema ? browserProviderProxyRequest( message ) : null;
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
		const proxyMessage = browserProviderProxyRequest( message );
		const body = JSON.stringify( proxyMessage );
		if ( body.length > browserProviderProxyMaxBytes ) {
			return browserProviderProxyError( 'wp_codebox_browser_provider_proxy_payload_too_large', 'Browser provider proxy request is too large.' );
		}

		const startedAt = Date.now();
		const requestSummary = summarizeBrowserProviderProxyMessage( proxyMessage );
		browserProviderDiagnostics().counts.started += 1;

		try {
			let result;
			if ( window.wp?.apiFetch ) {
				result = await window.wp.apiFetch( {
					path: '/wp-codebox/v1/browser-provider-request',
					method: 'POST',
					data: proxyMessage,
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

	const executeBrowserConnectorRequest = async ( input ) => executeBrowserProviderProxyRequest( browserConnectorRequest( input ) );

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

function wp_codebox_browser_operation_contained_path( $relative_path, $label ) {
	$relative = wp_codebox_browser_operation_safe_relative_path( $relative_path, $label );
	return ABSPATH . $relative;
}

function wp_codebox_browser_operation_dir_path( $relative_path, $label ) {
	if ( null === $relative_path || '' === $relative_path ) {
		return rtrim( ABSPATH, '/' );
	}

	$relative = wp_codebox_browser_operation_safe_relative_path( $relative_path, $label );
	return ABSPATH . $relative;
}

function wp_codebox_browser_operation_looks_binary( $content ) {
	return false !== strpos( substr( $content, 0, 8000 ), chr( 0 ) );
}

function wp_codebox_browser_operation_collect_files( $base ) {
	if ( is_file( $base ) ) {
		return array( $base );
	}

	$files = array();
	$iterator = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $base, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::LEAVES_ONLY
	);
	foreach ( $iterator as $info ) {
		if ( $info->isFile() ) {
			$path = (string) $info->getPathname();
			if ( false !== strpos( $path, '/.git/' ) ) {
				continue;
			}
			$files[] = $path;
		}
	}
	sort( $files );

	return $files;
}

function wp_codebox_browser_operation_apply_hunks( $original, $hunks ) {
	$had_trailing_newline = '' === $original || "\n" === substr( $original, -1 );
	$lines = '' === $original ? array() : explode( "\n", $original );
	if ( $had_trailing_newline && '' !== $original ) {
		array_pop( $lines );
	}

	$result = array();
	$cursor = 0;
	foreach ( $hunks as $hunk ) {
		$target = max( 0, (int) $hunk['old_start'] - 1 );
		while ( $cursor < $target && $cursor < count( $lines ) ) {
			$result[] = $lines[ $cursor ];
			$cursor++;
		}
		foreach ( $hunk['lines'] as $pair ) {
			$marker = $pair[0];
			$text = $pair[1];
			if ( ' ' === $marker ) {
				if ( ! isset( $lines[ $cursor ] ) || $lines[ $cursor ] !== $text ) {
					throw new RuntimeException( sprintf( 'Patch context mismatch at line %d.', $cursor + 1 ) );
				}
				$result[] = $lines[ $cursor ];
				$cursor++;
			} elseif ( '-' === $marker ) {
				if ( ! isset( $lines[ $cursor ] ) || $lines[ $cursor ] !== $text ) {
					throw new RuntimeException( sprintf( 'Patch removed-line mismatch at line %d.', $cursor + 1 ) );
				}
				$cursor++;
			} elseif ( '+' === $marker ) {
				$result[] = $text;
			}
		}
	}
	while ( $cursor < count( $lines ) ) {
		$result[] = $lines[ $cursor ];
		$cursor++;
	}

	$content = implode( "\n", $result );
	if ( $had_trailing_newline && '' !== $content ) {
		$content .= "\n";
	}

	return $content;
}

function wp_codebox_browser_operation_diff_path( $token ) {
	$token = trim( $token );
	$tab = strpos( $token, chr( 9 ) );
	if ( false !== $tab ) {
		$token = substr( $token, 0, $tab );
	}
	$token = trim( $token );
	if ( '/dev/null' === $token ) {
		return null;
	}
	if ( 0 === strpos( $token, 'a/' ) || 0 === strpos( $token, 'b/' ) ) {
		$token = substr( $token, 2 );
	}

	return $token;
}

function wp_codebox_browser_operation_parse_patch( $patch ) {
	$lines = explode( "\n", str_replace( "\r\n", "\n", $patch ) );
	$count = count( $lines );
	$files = array();
	$i = 0;
	while ( $i < $count ) {
		$line = $lines[ $i ];
		if ( 0 !== strpos( $line, '--- ' ) ) {
			$i++;
			continue;
		}
		$source = wp_codebox_browser_operation_diff_path( substr( $line, 4 ) );
		if ( $i + 1 >= $count || 0 !== strpos( $lines[ $i + 1 ], '+++ ' ) ) {
			throw new InvalidArgumentException( 'Malformed patch: missing +++ line.' );
		}
		$target = wp_codebox_browser_operation_diff_path( substr( $lines[ $i + 1 ], 4 ) );
		$i += 2;
		$hunks = array();
		while ( $i < $count && 0 === strpos( $lines[ $i ], '@@' ) ) {
			if ( ! preg_match( '/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/', $lines[ $i ], $m ) ) {
				throw new InvalidArgumentException( 'Malformed patch hunk header.' );
			}
			$hunk = array( 'old_start' => (int) $m[1], 'lines' => array() );
			$i++;
			while ( $i < $count ) {
				$hline = $lines[ $i ];
				if ( 0 === strpos( $hline, '@@' ) || 0 === strpos( $hline, '--- ' ) || 0 === strpos( $hline, 'diff --git ' ) ) {
					break;
				}
				if ( '' === $hline ) {
					break;
				}
				$marker = $hline[0];
				if ( chr( 92 ) === $marker ) {
					$i++;
					continue;
				}
				if ( ' ' !== $marker && '+' !== $marker && '-' !== $marker ) {
					break;
				}
				$hunk['lines'][] = array( $marker, substr( $hline, 1 ) );
				$i++;
			}
			$hunks[] = $hunk;
		}
		$files[] = array( 'source' => $source, 'target' => $target, 'hunks' => $hunks );
	}

	return $files;
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

		case 'readFile':
			$relative = wp_codebox_browser_operation_safe_relative_path( wp_codebox_browser_operation_arg( $operation, 'path' ), 'File' );
			$path = ABSPATH . $relative;
			if ( ! is_file( $path ) || ! is_readable( $path ) ) {
				throw new RuntimeException( sprintf( 'File is not readable: %s', $relative ) );
			}

			$max_bytes = (int) wp_codebox_browser_operation_arg( $operation, 'maxBytes', 1048576 );
			$size = (int) filesize( $path );
			if ( $max_bytes > 0 && $size > $max_bytes ) {
				throw new RuntimeException( sprintf( 'File is %d bytes, exceeding the %d byte limit.', $size, $max_bytes ) );
			}

			$content = file_get_contents( $path );
			if ( false === $content ) {
				throw new RuntimeException( sprintf( 'Unable to read file: %s', $relative ) );
			}

			$offset = (int) wp_codebox_browser_operation_arg( $operation, 'offset', 0 );
			$limit = (int) wp_codebox_browser_operation_arg( $operation, 'limit', 0 );
			$start_line = $offset > 0 ? $offset : 1;
			if ( $offset > 0 || $limit > 0 ) {
				$all_lines = explode( "\n", $content );
				$slice = array_slice( $all_lines, $start_line - 1, $limit > 0 ? $limit : null );
				$content = implode( "\n", $slice );
				$lines_read = count( $slice );
			} else {
				$lines_read = '' === $content ? 0 : substr_count( $content, "\n" ) + 1;
			}

			wp_codebox_browser_operation_response( true, array(
				'target' => 'file',
				'path' => $path,
				'relativePath' => $relative,
				'content' => $content,
				'size' => $size,
				'linesRead' => $lines_read,
				'offset' => $start_line,
			) );

		case 'listDirectory':
			$relative_arg = wp_codebox_browser_operation_arg( $operation, 'path', '' );
			$dir = wp_codebox_browser_operation_dir_path( $relative_arg, 'Directory' );
			if ( ! is_dir( $dir ) ) {
				throw new RuntimeException( sprintf( 'Not a directory: %s', is_string( $relative_arg ) ? $relative_arg : '' ) );
			}

			$entries = array();
			$names = scandir( $dir );
			foreach ( false === $names ? array() : $names as $name ) {
				if ( '.' === $name || '..' === $name ) {
					continue;
				}
				$full = $dir . '/' . $name;
				$entries[] = array(
					'name' => $name,
					'type' => is_dir( $full ) ? 'directory' : 'file',
					'size' => is_file( $full ) ? (int) filesize( $full ) : 0,
				);
			}
			usort( $entries, function ( $a, $b ) {
				if ( $a['type'] !== $b['type'] ) {
					return 'directory' === $a['type'] ? -1 : 1;
				}
				return strcmp( $a['name'], $b['name'] );
			} );

			wp_codebox_browser_operation_response( true, array(
				'target' => 'directory',
				'path' => is_string( $relative_arg ) ? $relative_arg : '',
				'entries' => $entries,
			) );

		case 'grep':
			$pattern = wp_codebox_browser_operation_arg( $operation, 'pattern' );
			if ( ! is_string( $pattern ) || '' === $pattern ) {
				throw new InvalidArgumentException( 'Grep requires a pattern.' );
			}
			$regex = chr( 126 ) . str_replace( chr( 126 ), chr( 92 ) . chr( 126 ), $pattern ) . chr( 126 );
			if ( false === @preg_match( $regex, '' ) ) {
				throw new InvalidArgumentException( 'Grep pattern is not a valid regular expression.' );
			}

			$relative_arg = wp_codebox_browser_operation_arg( $operation, 'path', '' );
			$base = wp_codebox_browser_operation_dir_path( $relative_arg, 'Search path' );
			if ( ! file_exists( $base ) ) {
				throw new RuntimeException( 'Search path does not exist.' );
			}

			$include = (string) wp_codebox_browser_operation_arg( $operation, 'include', '' );
			$max_results = max( 1, min( 500, (int) wp_codebox_browser_operation_arg( $operation, 'maxResults', 100 ) ) );
			$context_lines = max( 0, min( 10, (int) wp_codebox_browser_operation_arg( $operation, 'contextLines', 0 ) ) );
			$base_prefix = rtrim( ABSPATH, '/' ) . '/';

			$matches = array();
			$truncated = false;
			foreach ( wp_codebox_browser_operation_collect_files( $base ) as $file ) {
				$relative_file = 0 === strpos( $file, $base_prefix ) ? substr( $file, strlen( $base_prefix ) ) : $file;
				if ( '' !== $include && ! fnmatch( $include, $relative_file ) && ! fnmatch( $include, basename( $relative_file ) ) ) {
					continue;
				}
				if ( (int) filesize( $file ) > 1048576 ) {
					continue;
				}
				$content = file_get_contents( $file );
				if ( false === $content || wp_codebox_browser_operation_looks_binary( $content ) ) {
					continue;
				}
				$file_lines = explode( "\n", $content );
				foreach ( $file_lines as $index => $text_line ) {
					if ( 1 !== @preg_match( $regex, $text_line ) ) {
						continue;
					}
					if ( count( $matches ) >= $max_results ) {
						$truncated = true;
						break 2;
					}
					$match = array(
						'path' => $relative_file,
						'line' => $index + 1,
						'text' => $text_line,
					);
					if ( $context_lines > 0 ) {
						$match['context'] = array_values( array_slice( $file_lines, max( 0, $index - $context_lines ), $context_lines * 2 + 1 ) );
					}
					$matches[] = $match;
				}
			}

			wp_codebox_browser_operation_response( true, array(
				'target' => 'grep',
				'pattern' => $pattern,
				'count' => count( $matches ),
				'truncated' => $truncated,
				'matches' => $matches,
			) );

		case 'editFile':
			$relative = wp_codebox_browser_operation_safe_relative_path( wp_codebox_browser_operation_arg( $operation, 'path' ), 'File' );
			$path = ABSPATH . $relative;
			if ( ! is_file( $path ) || ! is_readable( $path ) ) {
				throw new RuntimeException( sprintf( 'File is not readable: %s', $relative ) );
			}

			$old = wp_codebox_browser_operation_arg( $operation, 'oldString', wp_codebox_browser_operation_arg( $operation, 'search', '' ) );
			$new = wp_codebox_browser_operation_arg( $operation, 'newString', wp_codebox_browser_operation_arg( $operation, 'replace', '' ) );
			if ( ! is_string( $old ) || '' === $old ) {
				throw new InvalidArgumentException( 'Edit requires oldString to find.' );
			}
			$new = is_string( $new ) ? $new : '';

			$content = file_get_contents( $path );
			if ( false === $content ) {
				throw new RuntimeException( sprintf( 'Unable to read file: %s', $relative ) );
			}

			$occurrences = substr_count( $content, $old );
			if ( 0 === $occurrences ) {
				throw new RuntimeException( 'Edit found no occurrence of oldString.' );
			}

			$replace_all = (bool) wp_codebox_browser_operation_arg( $operation, 'replaceAll', false );
			if ( ! $replace_all && $occurrences > 1 ) {
				throw new RuntimeException( sprintf( 'oldString matched %d times; pass replaceAll or a more specific string.', $occurrences ) );
			}

			if ( $replace_all ) {
				$updated = str_replace( $old, $new, $content, $replacements );
			} else {
				$pos = strpos( $content, $old );
				$updated = substr_replace( $content, $new, $pos, strlen( $old ) );
				$replacements = 1;
			}

			$bytes = file_put_contents( $path, $updated );
			if ( false === $bytes ) {
				throw new RuntimeException( sprintf( 'Unable to write file: %s', $relative ) );
			}

			wp_codebox_browser_operation_response( true, array(
				'target' => 'file',
				'path' => $path,
				'relativePath' => $relative,
				'replacements' => (int) $replacements,
			) );

		case 'applyPatch':
			$patch = wp_codebox_browser_operation_arg( $operation, 'patch' );
			if ( ! is_string( $patch ) || '' === trim( $patch ) ) {
				throw new InvalidArgumentException( 'Apply-patch requires a unified diff.' );
			}

			$patch_files = wp_codebox_browser_operation_parse_patch( $patch );
			if ( empty( $patch_files ) ) {
				throw new InvalidArgumentException( 'No file changes were found in the patch.' );
			}

			$staged = array();
			foreach ( $patch_files as $patch_file ) {
				$relative = wp_codebox_browser_operation_safe_relative_path(
					null === $patch_file['target'] ? $patch_file['source'] : $patch_file['target'],
					'Patch file'
				);
				$path = ABSPATH . $relative;
				if ( null === $patch_file['target'] ) {
					if ( ! is_file( $path ) ) {
						throw new RuntimeException( sprintf( 'Cannot delete missing file: %s', $relative ) );
					}
					$staged[] = array( 'op' => 'delete', 'path' => $path, 'relative' => $relative );
					continue;
				}

				$original = '';
				if ( null !== $patch_file['source'] ) {
					if ( ! is_file( $path ) ) {
						throw new RuntimeException( sprintf( 'Patch source file does not exist: %s', $relative ) );
					}
					$read = file_get_contents( $path );
					if ( false === $read ) {
						throw new RuntimeException( sprintf( 'Patch source file could not be read: %s', $relative ) );
					}
					$original = $read;
				} elseif ( is_file( $path ) ) {
					throw new RuntimeException( sprintf( 'Patch creates a file that already exists: %s', $relative ) );
				}

				$updated = wp_codebox_browser_operation_apply_hunks( $original, $patch_file['hunks'] );
				$staged[] = array( 'op' => 'write', 'path' => $path, 'relative' => $relative, 'content' => $updated );
			}

			$changed = array();
			foreach ( $staged as $entry ) {
				if ( 'delete' === $entry['op'] ) {
					if ( ! unlink( $entry['path'] ) ) {
						throw new RuntimeException( sprintf( 'Could not delete %s.', $entry['relative'] ) );
					}
					$changed[] = $entry['relative'];
					continue;
				}
				wp_codebox_browser_operation_mkdir( dirname( $entry['path'] ) );
				if ( false === file_put_contents( $entry['path'], $entry['content'] ) ) {
					throw new RuntimeException( sprintf( 'Could not write %s.', $entry['relative'] ) );
				}
				$changed[] = $entry['relative'];
			}

			wp_codebox_browser_operation_response( true, array(
				'target' => 'patch',
				'changedFiles' => array_values( array_unique( $changed ) ),
				'status' => 'applied',
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
		if ( options.forceRequest && typeof client?.writeFile !== 'function' && typeof client.run === 'function' ) {
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

	const readFile = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'readFile',
		args,
	}, options );

	const listDirectory = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'listDirectory',
		args,
	}, options );

	const grep = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'grep',
		args,
	}, options );

	const editFile = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'editFile',
		args,
	}, options );

	const applyPatch = ( client, args = {}, options = {} ) => runWordPressOperation( client, {
		type: 'applyPatch',
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
		dependsOn: Array.isArray( worker?.dependsOn ) ? worker.dependsOn.filter( ( value ) => typeof value === 'string' && value.length > 0 ) : [],
		required: worker?.required !== false,
		artifactNamespace: typeof worker?.artifactNamespace === 'string' ? worker.artifactNamespace : undefined,
	} );

	const normalizeFanoutArtifactRef = ( artifact, fallbackWorkerId ) => ( {
		id: typeof artifact?.id === 'string' ? artifact.id : undefined,
		path: typeof artifact?.path === 'string' ? artifact.path : '',
		kind: typeof artifact?.kind === 'string' ? artifact.kind : undefined,
		workerId: typeof artifact?.workerId === 'string' ? artifact.workerId : typeof fallbackWorkerId === 'string' ? fallbackWorkerId : undefined,
		namespace: typeof artifact?.namespace === 'string' ? artifact.namespace : undefined,
		finalPath: typeof artifact?.finalPath === 'string' ? artifact.finalPath : undefined,
		contentType: typeof artifact?.contentType === 'string' ? artifact.contentType : undefined,
		sha256: typeof artifact?.sha256 === 'string' ? artifact.sha256 : undefined,
		bytes: typeof artifact?.bytes === 'number' ? artifact.bytes : undefined,
		metadata: artifact?.metadata && typeof artifact.metadata === 'object' && ! Array.isArray( artifact.metadata ) ? artifact.metadata : undefined,
	} );

	const normalizeFanoutWorkerResultRef = ( worker ) => {
		const artifactRefs = Array.isArray( worker?.artifactRefs ) ? worker.artifactRefs : [];
		const workerId = typeof worker?.workerId === 'string' ? worker.workerId : '';
		const status = typeof worker?.status === 'string' && worker.status.length > 0 ? worker.status : 'missing';
		return {
			workerId,
			status: status === 'completed' && worker?.success === true ? 'succeeded' : status,
			required: worker?.required !== false,
			resultRef: typeof worker?.resultRef === 'string' ? worker.resultRef : undefined,
			artifactRefs: artifactRefs.map( ( artifact ) => normalizeFanoutArtifactRef( artifact, workerId ) ),
			...( worker?.error && typeof worker.error === 'object' ? { error: worker.error } : {} ),
			...( worker?.metadata && typeof worker.metadata === 'object' && ! Array.isArray( worker.metadata ) ? { metadata: worker.metadata } : {} ),
		};
	};

	const normalizeFanoutConflict = ( conflict ) => ( {
		type: typeof conflict?.type === 'string' ? conflict.type : 'partial-output',
		severity: typeof conflict?.severity === 'string' ? conflict.severity : 'error',
		message: typeof conflict?.message === 'string' ? conflict.message : 'Fanout aggregation conflict candidate.',
		...( Array.isArray( conflict?.workerIds ) ? { workerIds: conflict.workerIds.filter( ( value ) => typeof value === 'string' && value.length > 0 ) } : {} ),
		...( typeof conflict?.path === 'string' ? { path: conflict.path } : {} ),
		...( typeof conflict?.dependencyId === 'string' ? { dependencyId: conflict.dependencyId } : {} ),
		...( conflict?.details && typeof conflict.details === 'object' && ! Array.isArray( conflict.details ) ? { details: conflict.details } : {} ),
	} );

	const normalizeFanoutAggregationInput = ( input ) => {
		const source = input && typeof input === 'object' ? input : {};
		const workerResultRefs = ( Array.isArray( source.workerResultRefs ) ? source.workerResultRefs : [] ).map( normalizeFanoutWorkerResultRef );
		const directArtifactRefs = ( Array.isArray( source.artifactRefs ) ? source.artifactRefs : [] ).map( ( artifact ) => normalizeFanoutArtifactRef( artifact ) );
		const artifactRefs = source.schema === fanoutAggregationInputSchema ? directArtifactRefs : [ ...directArtifactRefs, ...workerResultRefs.flatMap( ( worker ) => worker.artifactRefs ) ];
		return {
			schema: fanoutAggregationInputSchema,
			plan: {
				...( source.plan && typeof source.plan === 'object' ? source.plan : {} ),
				workers: ( Array.isArray( source.plan?.workers ) ? source.plan.workers : [] ).map( normalizeFanoutWorkerPlan ),
			},
			policy: typeof source.policy === 'string' ? source.policy : 'fail',
			aggregator: source.aggregator && typeof source.aggregator === 'object' ? source.aggregator : undefined,
			workerResultRefs,
			artifactRefs,
			conflictCandidates: ( Array.isArray( source.conflictCandidates ) ? source.conflictCandidates : [] ).map( normalizeFanoutConflict ),
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
			metadata: normalized.metadata,
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

	const preparedBrowserRuntimeContract = ( session ) => {
		const playground = session?.playground && typeof session.playground === 'object' ? session.playground : {};
		const runtime = session?.runtime && typeof session.runtime === 'object' ? session.runtime : {};
		const prepared = playground.prepared_runtime && typeof playground.prepared_runtime === 'object'
			? playground.prepared_runtime
			: ( runtime.prepared_runtime && typeof runtime.prepared_runtime === 'object' ? runtime.prepared_runtime : null );
		if ( ! prepared || prepared.schema !== 'wp-codebox/browser-prepared-runtime/v1' ) {
			return {
				schema: 'wp-codebox/browser-prepared-runtime/v1',
				status: 'disabled',
				selected: 'fallback',
			};
		}

		return prepared;
	};

	const selectPreparedBrowserBlueprint = ( session ) => {
		const prepared = preparedBrowserRuntimeContract( session );
		if ( prepared.selected === 'prepared' && prepared.blueprint && typeof prepared.blueprint === 'object' ) {
			return prepared.blueprint;
		}

		if ( prepared.fallback_blueprint && typeof prepared.fallback_blueprint === 'object' ) {
			return prepared.fallback_blueprint;
		}

		return session?.playground?.blueprint && typeof session.playground.blueprint === 'object' ? session.playground.blueprint : null;
	};

	const preparedBrowserRuntimeStatus = ( session ) => {
		const prepared = preparedBrowserRuntimeContract( session );
		return {
			schema: 'wp-codebox/browser-prepared-runtime-status/v1',
			status: prepared.status || 'disabled',
			selected: prepared.selected || 'fallback',
			cache_key: prepared.cache_key || '',
			input_hash: prepared.input_hash || '',
			source_digest: prepared.diagnostics?.source_digest || prepared.snapshot?.source_digest || null,
			diagnostics: prepared.diagnostics || null,
			invalidation: prepared.invalidation || null,
		};
	};

	const executableBrowserSession = ( input ) => {
		const session = input?.schema === 'wp-codebox/browser-session-product-dto/v1'
			? input.executable_session
			: input;
		if ( ! session || typeof session !== 'object' ) {
			throw runtimeError( 'executable_session_validate', 'browser_executable_session_missing', 'WP Codebox executable browser session is required.' );
		}
		if ( session.schema !== 'wp-codebox/browser-executable-session/v1' ) {
			throw runtimeError( 'executable_session_validate', 'browser_executable_session_schema_unsupported', `Unsupported WP Codebox executable session schema: ${ session.schema || 'missing' }` );
		}
		if ( session.success === false || session.status === 'blocked' ) {
			throw runtimeError( 'executable_session_validate', 'browser_executable_session_not_ready', session?.error?.message || 'WP Codebox executable browser session is not ready.' );
		}

		return session;
	};

	const executableBrowserRuntimeHandoff = ( input ) => {
		const session = executableBrowserSession( input );
		const handoff = session.runtime_handoff && typeof session.runtime_handoff === 'object' ? session.runtime_handoff : {};
		if ( handoff.schema && handoff.schema !== 'wp-codebox/browser-runtime-handoff/v1' ) {
			throw runtimeError( 'runtime_handoff_validate', 'browser_runtime_handoff_schema_unsupported', `Unsupported WP Codebox browser runtime handoff schema: ${ handoff.schema }` );
		}
		const blueprintRef = handoff.blueprint_ref && typeof handoff.blueprint_ref === 'object'
			? handoff.blueprint_ref
			: ( session.blueprint_ref && typeof session.blueprint_ref === 'object' ? session.blueprint_ref : null );
		const blueprintRefDto = handoff.blueprint_ref_dto && typeof handoff.blueprint_ref_dto === 'object'
			? handoff.blueprint_ref_dto
			: ( session.preview_boot?.blueprint_ref_dto && typeof session.preview_boot.blueprint_ref_dto === 'object' ? session.preview_boot.blueprint_ref_dto : blueprintRef );

		return {
			schema: 'wp-codebox/browser-runtime-handoff/v1',
			owner: 'wp-codebox',
			...handoff,
			session_id: handoff.session_id || session.session_id || '',
			blueprint_ref: blueprintRef,
			blueprint_ref_dto: blueprintRefDto,
			hydrator_ability: handoff.hydrator_ability || blueprintRef?.hydrator_ability || blueprintRefDto?.hydrator_ability || 'wp-codebox/hydrate-browser-blueprint-ref',
			parent_tool_bridge: handoff.parent_tool_bridge && typeof handoff.parent_tool_bridge === 'object' ? handoff.parent_tool_bridge : parentToolBridge( session ),
		};
	};

	const parentToolBridge = ( input ) => {
		const source = input?.schema === 'wp-codebox/browser-session-product-dto/v1'
			? input.executable_session
			: input;
		const handoff = source?.runtime_handoff && typeof source.runtime_handoff === 'object' ? source.runtime_handoff : {};
		const bridge = source?.parent_tool_bridge && typeof source.parent_tool_bridge === 'object'
			? source.parent_tool_bridge
			: ( handoff.parent_tool_bridge && typeof handoff.parent_tool_bridge === 'object' ? handoff.parent_tool_bridge : null );
		return bridge && bridge.schema === 'wp-codebox/parent-tool-bridge/v1' ? bridge : null;
	};

	const createParentToolRequest = ( sessionInput, tool, operation, input = {}, metadata = {} ) => {
		const session = executableBrowserSession( sessionInput );
		const bridge = parentToolBridge( session );
		if ( ! bridge ) {
			throw runtimeError( 'parent_tool_bridge', 'parent_tool_bridge_missing', 'WP Codebox parent tool bridge is not available for this executable browser session.' );
		}
		const toolName = String( tool || '' );
		if ( ! toolName || ! Array.isArray( bridge.allowed_tools ) || ! bridge.allowed_tools.includes( toolName ) ) {
			throw runtimeError( 'parent_tool_bridge', 'parent_tool_denied', `Parent tool is not allowed: ${ toolName || 'missing' }` );
		}

		return {
			schema: bridge.dispatcher?.request_schema || 'wp-codebox/parent-tool-request/v1',
			version: 1,
			request_id: `ptr-${ Date.now().toString( 36 ) }-${ Math.random().toString( 36 ).slice( 2, 10 ) }`,
			tool: toolName,
			operation: String( operation || 'call' ),
			input,
			sandbox_session: {
				sandbox_session_id: String( session.session_id || '' ),
			},
			authorization: {
				allowed_tools: [ ...bridge.allowed_tools ],
			},
			metadata: metadata && typeof metadata === 'object' ? metadata : {},
		};
	};

	const dispatchParentTool = async ( session, tool, operation, input = {}, options = {} ) => {
		if ( typeof options.dispatchParentTool !== 'function' ) {
			throw runtimeError( 'parent_tool_bridge', 'parent_tool_dispatcher_missing', 'A host parent-tool dispatcher callback is required.' );
		}
		const request = createParentToolRequest( session, tool, operation, input, options.metadata || {} );
		const result = await options.dispatchParentTool( request, { bridge: parentToolBridge( session ) } );
		if ( ! result || typeof result !== 'object' || result.schema !== 'wp-codebox/parent-tool-result/v1' ) {
			throw runtimeError( 'parent_tool_bridge', 'parent_tool_result_invalid', 'Parent tool dispatcher returned an invalid WP Codebox result envelope.' );
		}
		return result;
	};

	const hydrateExecutableBrowserBlueprint = async ( session, options = {} ) => {
		const handoff = executableBrowserRuntimeHandoff( session );
		const blueprintRef = handoff.blueprint_ref_dto || handoff.blueprint_ref;
		const ref = blueprintRef?.ref || blueprintRef?.id || handoff.blueprint_ref || '';
		if ( ! ref ) {
			throw runtimeError( 'blueprint_hydration', 'browser_blueprint_ref_missing', 'Executable browser session is missing a Codebox blueprint ref.' );
		}
		if ( typeof options.hydrateBlueprintRef !== 'function' ) {
			throw runtimeError( 'blueprint_hydration', 'browser_blueprint_hydrator_missing', 'A Codebox blueprint-ref hydrator callback is required.' );
		}

		const hydrated = await options.hydrateBlueprintRef( {
			schema: 'wp-codebox/browser-blueprint-ref-hydration-request/v1',
			ability: handoff.hydrator_ability,
			ref,
			blueprint_ref: blueprintRef,
			session_id: handoff.session_id || '',
		}, handoff );
		const blueprint = hydrated?.blueprint && typeof hydrated.blueprint === 'object'
			? hydrated.blueprint
			: ( hydrated?.data?.blueprint && typeof hydrated.data.blueprint === 'object' ? hydrated.data.blueprint : hydrated );
		if ( ! blueprint || typeof blueprint !== 'object' || ! Array.isArray( blueprint.steps ) ) {
			throw runtimeError( 'blueprint_hydration', 'browser_blueprint_hydration_invalid', 'Codebox blueprint hydrator did not return an executable blueprint.' );
		}

		return {
			schema: 'wp-codebox/browser-blueprint-hydration-result/v1',
			ref,
			blueprint,
			hydrated,
		};
	};

	const runExecutableBrowserBlueprint = async ( client, blueprint, options = {} ) => {
		return await invokePlaygroundMethod( 'blueprint_run', 'runBlueprint', [
			{ label: 'client-run-blueprint-envelope', shape: 'client.run', run: () => client.run( { blueprint } ) },
			{ label: 'client-run-blueprint', shape: 'client.run', run: () => client.run( blueprint ) },
			{ label: 'client-runBlueprint', shape: 'client.runBlueprint', run: () => client.runBlueprint( blueprint ) },
			{ label: 'client-applyBlueprint', shape: 'client.applyBlueprint', run: () => client.applyBlueprint( blueprint ) },
		] );
	};

	const bootExecutableBrowserSession = async ( client, sessionInput, options = {} ) => {
		const session = executableBrowserSession( sessionInput );
		if ( options.validateReadiness !== false && session.runtime_readiness?.ready === false ) {
			throw runtimeError( 'executable_session_validate', 'browser_executable_session_not_ready', session.runtime_readiness?.message || 'WP Codebox executable browser session runtime is not ready.', session.runtime_readiness );
		}
		const hydration = await hydrateExecutableBrowserBlueprint( session, options );
		const bootResult = await runExecutableBrowserBlueprint( client, hydration.blueprint, options );
		return {
			schema: 'wp-codebox/browser-executable-session-boot-result/v1',
			success: true,
			status: 'completed',
			session_id: session.session_id || '',
			blueprint_ref: hydration.ref,
			result: bootResult ?? null,
			preview: session.preview || session.runtime_access?.lease || null,
			runtime_access: session.runtime_access || null,
			parent_tool_bridge: parentToolBridge( session ),
		};
	};

	const runtimeDependencySpecs = ( session, field ) => {
		const runtime = session?.runtime && typeof session.runtime === 'object' ? session.runtime : {};
		return Array.isArray( runtime[ field ] ) ? runtime[ field ].filter( isPlainObject ) : [];
	};

	const runtimeMaterializationRequest = ( session ) => ( {
		schema: 'wp-codebox/browser-runtime-materialization-request/v1',
		plugins: runtimeDependencySpecs( session, 'plugins' ).map( ( plugin ) => ( {
			slug: String( plugin.slug || '' ),
			targetFolderName: String( plugin.targetFolderName || plugin.slug || '' ),
			activate: plugin.activate !== false,
			required: plugin.required !== false,
		} ) ).filter( ( plugin ) => plugin.slug || plugin.targetFolderName ),
		mu_plugins: runtimeDependencySpecs( session, 'mu_plugins' ).map( ( plugin ) => ( {
			slug: String( plugin.slug || '' ),
			file: String( plugin.file || ( plugin.slug ? `${ plugin.slug }.php` : '' ) ),
			required: plugin.required !== false,
		} ) ).filter( ( plugin ) => plugin.file || plugin.slug ),
	} );

	const runtimeMaterializationProbePhp = ( request ) => `<?php
if ( ! defined( 'ABSPATH' ) ) {
	require_once '/wordpress/wp-load.php';
}
require_once ABSPATH . 'wp-admin/includes/plugin.php';
$request = json_decode( base64_decode( '${ base64Json( request ) }' ), true );
$request = is_array( $request ) ? $request : array();
$active_plugins = array_map( 'strval', (array) get_option( 'active_plugins', array() ) );
$mu_plugin_files = array_map( 'basename', glob( WPMU_PLUGIN_DIR . '/*.php' ) ?: array() );
$dependencies = array();
$diagnostics = array();

foreach ( is_array( $request['plugins'] ?? null ) ? $request['plugins'] : array() as $plugin ) {
	$slug = sanitize_key( (string) ( $plugin['slug'] ?? '' ) );
	$target_folder = sanitize_key( (string) ( $plugin['targetFolderName'] ?? $slug ) );
	$activate = false !== ( $plugin['activate'] ?? true );
	$required = false !== ( $plugin['required'] ?? true );
	$installed_plugins = '' !== $target_folder ? get_plugins( '/' . $target_folder ) : array();
	$plugin_file = '';
	foreach ( array_keys( $installed_plugins ) as $file ) {
		$plugin_file = $target_folder . '/' . $file;
		break;
	}
	$installed = '' !== $plugin_file;
	$active = $installed && in_array( $plugin_file, $active_plugins, true );
	$status = $installed ? ( $activate ? ( $active ? 'active' : 'inactive' ) : 'installed' ) : 'missing';
	$code = '';
	if ( $required && ! $installed ) {
		$code = 'wp_codebox_browser_runtime_plugin_missing';
	} elseif ( $required && $activate && ! $active ) {
		$code = 'wp_codebox_browser_runtime_plugin_inactive';
	}
	$dependency = array_filter( array(
		'kind' => 'plugin',
		'slug' => $slug,
		'targetFolderName' => $target_folder,
		'required' => $required,
		'activate' => $activate,
		'status' => $status,
		'pluginFile' => $plugin_file,
		'evidence' => array(
			'installed' => $installed,
			'active' => $active,
		),
		'code' => $code,
	), static fn( $value ) => '' !== $value && null !== $value );
	$dependencies[] = $dependency;
	if ( '' !== $code ) {
		$diagnostics[] = array(
			'code' => $code,
			'severity' => 'error',
			'kind' => 'plugin',
			'slug' => $slug,
			'targetFolderName' => $target_folder,
			'pluginFile' => $plugin_file,
			'message' => 'Required browser runtime plugin is not active.',
		);
	}
}

foreach ( is_array( $request['mu_plugins'] ?? null ) ? $request['mu_plugins'] : array() as $plugin ) {
	$slug = sanitize_key( (string) ( $plugin['slug'] ?? '' ) );
	$file = basename( (string) ( $plugin['file'] ?? ( '' !== $slug ? $slug . '.php' : '' ) ) );
	$required = false !== ( $plugin['required'] ?? true );
	$materialized = '' !== $file && in_array( $file, $mu_plugin_files, true );
	$status = $materialized ? 'materialized' : 'missing';
	$code = $required && ! $materialized ? 'wp_codebox_browser_runtime_mu_plugin_missing' : '';
	$dependencies[] = array_filter( array(
		'kind' => 'mu-plugin',
		'slug' => $slug,
		'file' => $file,
		'required' => $required,
		'status' => $status,
		'evidence' => array( 'materialized' => $materialized ),
		'code' => $code,
	), static fn( $value ) => '' !== $value && null !== $value );
	if ( '' !== $code ) {
		$diagnostics[] = array(
			'code' => $code,
			'severity' => 'error',
			'kind' => 'mu-plugin',
			'slug' => $slug,
			'file' => $file,
			'message' => 'Required browser runtime mu-plugin is not materialized.',
		);
	}
}

$success = empty( $diagnostics );
echo wp_json_encode( array(
	'schema' => 'wp-codebox/browser-runtime-materialization-result/v1',
	'success' => $success,
	'status' => $success ? 'ready' : 'failed',
	'dependencies' => $dependencies,
	'diagnostics' => $diagnostics,
	'error' => $success ? null : array(
		'code' => 'wp_codebox_browser_runtime_materialization_failed',
		'message' => 'Browser runtime dependencies failed to materialize.',
		'diagnostics' => $diagnostics,
	),
) );
`;

	const validateBrowserRuntimeMaterialization = async ( client, session, options = {} ) => {
		const request = runtimeMaterializationRequest( session );
		if ( request.plugins.length === 0 && request.mu_plugins.length === 0 ) {
			return {
				schema: 'wp-codebox/browser-runtime-materialization-result/v1',
				success: true,
				status: 'skipped',
				dependencies: [],
				diagnostics: [],
				error: null,
			};
		}

		const result = await runPhpRequest( client, {
			...options,
			code: runtimeMaterializationProbePhp( request ),
			name: options.name || 'codebox-runtime-materialization-probe',
			expectJson: true,
		} );

		if ( result?.schema === 'wp-codebox/browser-runtime-materialization-result/v1' ) {
			return result;
		}

		return {
			schema: 'wp-codebox/browser-runtime-materialization-result/v1',
			success: false,
			status: 'failed',
			dependencies: [],
			diagnostics: [ {
				code: 'wp_codebox_browser_runtime_validation_invalid_response',
				severity: 'error',
				message: 'Browser runtime materialization probe returned an invalid response.',
				response: result ?? null,
			} ],
			error: {
				code: 'wp_codebox_browser_runtime_validation_invalid_response',
				message: 'Browser runtime materialization probe returned an invalid response.',
			},
		};
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
		const payload = taskPayload === undefined ? ( session.task_payload ?? session.task_input ?? {} ) : taskPayload;
		if ( options.validateRuntime !== false ) {
			const materialization = await validateBrowserRuntimeMaterialization( client, session, {
				...options,
				name: options.runtimeValidationName || 'codebox-browser-session-runtime',
			} );
			if ( ! materialization.success ) {
				throw runtimeError(
					'browser_runtime_materialization',
					materialization?.error?.code || 'wp_codebox_browser_runtime_materialization_failed',
					materialization?.error?.message || 'Browser runtime dependencies failed to materialize.',
					materialization
				);
			}
		}
		const recipe = browserSessionRecipe( session );
		const executableRecipe = payload?.agent_bundles && Array.isArray( payload.agent_bundles ) && payload.agent_bundles.length
			? {
				...recipe,
				inputs: {
					...( recipe.inputs && typeof recipe.inputs === 'object' ? recipe.inputs : {} ),
					agent_bundles: payload.agent_bundles,
				},
			}
			: recipe;
		return runRecipe( client, executableRecipe, payload, {
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
			const functions = [ 'runPhpRequest', 'runRecipe', 'runBrowserSessionRecipe', 'runWordPressOperation', 'writeFile', 'preparedBrowserRuntimeContract', 'selectPreparedBrowserBlueprint', 'preparedBrowserRuntimeStatus' ];
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
						{ id: 'worker-a', artifactNamespace: 'fanout/workers/worker-a' },
						{ id: 'worker-b', dependsOn: [ 'worker-a' ], artifactNamespace: 'fanout/workers/worker-b' },
					],
				},
				policy: 'fail',
				aggregator: {
					outputNamespace: 'aggregate/final',
				},
				workerResultRefs: [
					{
						workerId: 'worker-a',
						status: 'succeeded',
						artifactRefs: [ { path: 'fanout/workers/worker-a/result.json', finalPath: 'worker-a/result.json' } ],
					},
					{
						workerId: 'worker-b',
						status: 'succeeded',
						artifactRefs: [ { path: 'fanout/workers/worker-b/result.json', finalPath: 'worker-b/result.json' } ],
					},
				],
			}, { name: 'codebox-contract-fanout-aggregation' } );

			if ( true !== result?.success || result?.data?.schema !== fanoutAggregationOutputSchema ) {
				throw new Error( result?.error?.message || 'Fanout aggregation phase did not return the aggregation output contract.' );
			}

			return {
				schema: result.data.schema,
				status: result.data.status,
				finalPath: result.data.finalArtifactRefs?.[ 0 ]?.path || '',
				workerResults: result.data.workerResultRefs?.length || 0,
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

	const wpCodeboxBrowserApi = {
		activateTheme,
		aggregateFanoutOutputs,
		browserSessionRecipe,
		bootExecutableBrowserSession,
		consumeContainedSiteSync,
		createBrowserConnectorRequest: browserConnectorRequest,
		executeBrowserConnectorRequest,
		executeBrowserProviderProxyRequest,
		createParentToolRequest,
		dispatchParentTool,
		ensureDirectory,
		executableBrowserSession,
		installTheme,
		normalizeOperationResult,
		parentToolBridge,
		parseJsonResponse,
		preparedBrowserRuntimeContract,
		preparedBrowserRuntimeStatus,
		runBrowserRuntimeContractProbe,
		runBrowserSessionRecipe,
		runPhpRequest,
		runRecipe,
		runWordPressOperation,
		selectPreparedBrowserBlueprint,
		setFrontendAdminBarVisible,
		startBrowserPreview,
		validateBrowserRuntimeMaterialization,
		writeFile,
		readFile,
		listDirectory,
		grep,
		editFile,
		applyPatch,
		writeReviewFile,
	};
	wpCodeboxBrowserApi.v1 = browserSdkFacade( wpCodeboxBrowserApi );
	window.wpCodeboxBrowser = wpCodeboxBrowserApi;
	window.wpCodebox = Object.freeze( {
		...( window.wpCodebox && typeof window.wpCodebox === 'object' ? window.wpCodebox : {} ),
		startBrowserPreview,
		browser: wpCodeboxBrowserApi.v1,
	} );
} )();
