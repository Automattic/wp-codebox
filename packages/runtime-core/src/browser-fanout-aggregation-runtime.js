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
