import { authenticateProvisioningRequest, provisioningTokenAllowsSite, provisioningIdempotencyKey, type ProvisioningEnv } from "./provisioning-api.js"
import { parseSiteContexts, type SiteContext } from "./site-context.js"
import { type MarkdownPointer, type RevisionCoordinator, type RevisionLease, RevisionConflict } from "./revision-coordinator.js"
import { validateNativeBricksArtifact, stableJson, sha256Hex, MAX_NATIVE_BRICKS_ARTIFACT_BYTES, type NativeBricksArtifact } from "./native-bricks-artifact.js"
import { readBoundedRequestBytes } from "./static-artifact-import.js"

export interface NativePointer {
  receipt_id: string; canonical_state_version: number; canonical_state_revision: string
  canonical_manifest_key: string; canonical_persisted_at: string; artifact_sha256: string
  native_document_hashes: string[]; design_system_version: string
}
export interface NativeMutation {
  schema: "wp-codebox/native-bricks-mutation-request/v1"; action: "provision" | "revise" | "restore"
  idempotencyKey: string; operationId: string; siteId: string; customerId: string
  artifact: { sha256: string; size: number; r2Key: string } | null
  authority: { expectedBase: NativePointer | null; restoreTarget: NativePointer | null }
  targetRequest: Record<string, any>
}
export interface NativeSeed extends MarkdownPointer { runtime: { version: string; sha256: string } }
export interface NativeEnv extends ProvisioningEnv { WORDPRESS_BRICKS_PREPARED_ALLOCATIONS?: string }
export interface NativeExecution { pointer: MarkdownPointer; receipt: Record<string, any> }
export interface NativeBackend {
  coordinator(site: SiteContext): RevisionCoordinator
  execute(site: SiteContext, input: NativeMutation, artifact: NativeBricksArtifact | null, lease: RevisionLease, prepare: (result: NativeExecution) => Promise<void>): Promise<NativeExecution>
}
interface OperationRow { site_id: string; operation_id: string; principal: string; fingerprint: string; input_json: string; state: string; prepared_json: string | null; receipt_json: string | null; error_json: string | null; generation: number }
const ready = new WeakMap<object, Promise<void>>()
const schema = "wp-codebox/provisioning-api/v1"
const id = /^[A-Za-z0-9_-]{1,160}$/
const digest = /^[a-f0-9]{64}$/

export async function routeNativeBricksApi(request: Request, env: NativeEnv, backend: NativeBackend): Promise<Response | null> {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean)
  const poll = parts.length === 5 && parts[0] === "v1" && parts[1] === "sites" && parts[3] === "operations"
  if (!(parts[0] === "v1" && parts[1] === "bricks") && !poll) return null
  if (poll) {
    await initialize(env)
    const row = await byOperation(env, parts[2], parts[4])
    if (!row) return null
    if (request.method !== "GET") return error(405, "method_not_allowed", "GET is required.")
    const token = await authenticateProvisioningRequest(request, env, "sites:read")
    if (token instanceof Response) return token
    if (row.principal !== token.principal || !provisioningTokenAllowsSite(token, row.site_id)) return error(404, "not_found", "Operation unavailable.")
    return resource(row)
  }
  if (parts.length === 4 && parts[2] === "artifacts" && digest.test(parts[3])) return stage(request, env, parts[3])
  const action = parts.length === 3 && parts[2] === "sites" ? "provision" : parts.length === 5 && parts[2] === "sites" ? parts[4] === "revisions" ? "revise" : parts[4] === "restores" ? "restore" : null : null
  if (!action) return error(404, "not_found", "Native route unavailable.")
  if (request.method !== "POST") return error(405, "method_not_allowed", "POST is required.")
  const token = await authenticateProvisioningRequest(request, env, action === "provision" ? "sites:create" : "sites:import")
  if (token instanceof Response) return token
  const key = provisioningIdempotencyKey(request); if (key instanceof Response) return key
  let input: NativeMutation
  let seed: NativeSeed
  let site: SiteContext
  let artifact: NativeBricksArtifact | null = null
  try {
    input = JSON.parse(new TextDecoder().decode(await readBoundedRequestBytes(request, 128 * 1024)))
    validateNativeMutation(input, action, key)
    if (parts.length === 5 && parts[3] !== input.siteId) throw new Error("Path and requested site disagree.")
    if (!provisioningTokenAllowsSite(token, input.siteId)) return error(404, "not_found", "Allocation unavailable.")
    const contexts = parseSiteContexts(env.WORDPRESS_SITE_CONTEXTS)
    const configured = contexts.find(value => value.id === input.siteId)
    const seeds = JSON.parse(env.WORDPRESS_BRICKS_PREPARED_ALLOCATIONS ?? "{}")
    if (!configured || !seeds[input.siteId]) return error(409, "native_allocation_unprepared", "Native provisioning requires an operator-prepared isolated Bricks allocation.")
    site = configured; seed = seeds[input.siteId]
    if (!seed.revision || !seed.manifestKey || !seed.persistedAt || !digest.test(seed.runtime?.sha256 ?? "")) throw new Error("Prepared allocation pin is invalid.")
    if (input.targetRequest.runtime_artifact?.sha256 !== seed.runtime.sha256 || input.targetRequest.runtime_artifact?.version !== seed.runtime.version) throw new Error("Bricks runtime package does not match the prepared allocation.")
    const artifactHash = input.artifact?.sha256 ?? input.authority.restoreTarget!.artifact_sha256
    {
      const object = await env.WORDPRESS_STATE_BUCKET.get(artifactKey(artifactHash))
      if (!object || (input.artifact && object.size !== input.artifact.size)) throw new Error("Staged native artifact unavailable.")
      const bytes = new Uint8Array(await object.arrayBuffer())
      if (await sha256Hex(bytes) !== artifactHash) throw new Error("Staged native artifact digest mismatch.")
      artifact = await validateNativeBricksArtifact(bytes)
      if (artifactHash !== input.targetRequest.bricks_artifact?.sha256) throw new Error("Native payload digest differs from the target request.")
      if (stableJson(artifact.editing) !== stableJson(input.targetRequest.editing) || artifact.site.starter_id !== input.targetRequest.starter_id || stableJson(artifact.runtime) !== stableJson(input.targetRequest.runtime_artifact)) throw new Error("Native editing or runtime authority mismatch.")
      if (artifact.site.site_id !== input.siteId || artifact.site.customer_id !== input.customerId || artifact.runtime.sha256 !== seed.runtime.sha256) throw new Error("Native artifact identity or runtime mismatch.")
      if (stableJson(artifact.evidence_inputs.dossier) !== stableJson(input.targetRequest.dossier) || stableJson(artifact.evidence_inputs.creative_provenance) !== stableJson(input.targetRequest.creative_provenance) || stableJson(artifact.evidence_inputs.authorized_asset_hashes) !== stableJson(input.targetRequest.authorized_assets.map((asset: any) => asset.sha256))) throw new Error("Native artifact source authority mismatch.")
    }
  } catch (cause) { return error(400, "invalid_native_mutation", message(cause)) }
  await initialize(env)
  const fingerprint = await sha256Hex(new TextEncoder().encode(stableJson(input)))
  let row = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT * FROM wp_codebox_native_operations WHERE site_id = ? AND idempotency_key = ?").bind(site.id, key).first<OperationRow>()
  if (row && (row.fingerprint !== fingerprint || row.principal !== token.principal || row.operation_id !== input.operationId)) return error(409, "idempotency_conflict", "Idempotency key belongs to a different native mutation.")
  if (!row && await byOperation(env, site.id, input.operationId)) return error(409, "idempotency_conflict", "Operation ID belongs to a different idempotency key.")
  if (row?.state === "succeeded") return resource(row)
  const coordinator = backend.coordinator(site)
  let lease: RevisionLease | undefined
  let committed = false
  try {
    const now = Date.now()
    await env.WORDPRESS_STATE_DATABASE.prepare("INSERT OR IGNORE INTO wp_codebox_sites(site_id,hostname,origin,state,created_at,activated_at,updated_at) VALUES(?,?,?,'active',?,?,?)").bind(site.id,site.hostname,site.origin,now,now,now).run()
    lease = await coordinator.acquire(600_000)
    const lifecycle = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT s.generation, s.state, l.state AS lifecycle_state, l.expires_at FROM wp_codebox_sites s LEFT JOIN wp_codebox_site_lifecycles l ON l.site_id=s.site_id AND l.generation=s.generation WHERE s.site_id=?").bind(site.id).first<{generation:number;state:string;lifecycle_state:string|null;expires_at:number|null}>()
    if (!lifecycle || lifecycle.state !== "active" || (lifecycle.lifecycle_state !== null && (lifecycle.lifecycle_state !== "active" || (lifecycle.expires_at ?? 0) <= Date.now()))) throw new RevisionConflict("Prepared allocation is inactive.")
    if (row && row.generation !== lifecycle.generation) throw new RevisionConflict("Allocation generation changed.")
    if (row?.prepared_json) {
      const prepared: NativeExecution = JSON.parse(row.prepared_json)
      const receipt = await coordinator.committed(prepared.receipt.revision_receipt.canonical_state_version)
      if (sameManifest(receipt, prepared.pointer)) { await finish(env, row, prepared.receipt); await coordinator.release(lease); committed = true; return resource((await byOperation(env, site.id, input.operationId))!) }
    }
    const prior = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT receipt_json FROM wp_codebox_native_operations WHERE site_id=? AND state='succeeded' ORDER BY committed_version DESC LIMIT 1").bind(site.id).first<{receipt_json:string}>()
    const priorReceipt = prior ? JSON.parse(prior.receipt_json) : null
    if (input.action === "provision") {
      if (priorReceipt || !sameManifest(lease.pointer, seed)) throw new RevisionConflict("Provision requires the exact unused prepared allocation.")
    } else if (!priorReceipt || stableJson(priorReceipt.revision_receipt) !== stableJson(input.authority.expectedBase) || !pointerMatchesLease(input.authority.expectedBase!, lease)) throw new RevisionConflict("Exact native revision is stale.")
    if (input.action === "restore") {
      const target = input.authority.restoreTarget!
      const saved = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT receipt_json FROM wp_codebox_native_operations WHERE site_id=? AND state='succeeded' AND committed_version=?").bind(site.id, target.canonical_state_version).first<{receipt_json:string}>()
      if (!saved || stableJson(JSON.parse(saved.receipt_json).revision_receipt) !== stableJson(target)) throw new RevisionConflict("Restore target is not an exact committed native revision.")
    }
    if (!row) {
      const owner = await env.WORDPRESS_STATE_DATABASE.prepare("SELECT principal FROM wp_codebox_native_operations WHERE site_id=? LIMIT 1").bind(site.id).first<{principal:string}>()
      if (owner && owner.principal !== token.principal) throw new RevisionConflict("Allocation belongs to another principal.")
      await env.WORDPRESS_STATE_DATABASE.prepare("INSERT INTO wp_codebox_native_operations(site_id,operation_id,idempotency_key,principal,fingerprint,input_json,state,generation,created_at) VALUES(?,?,?,?,?,?,'running',?,?)").bind(site.id,input.operationId,key,token.principal,fingerprint,JSON.stringify(input),lifecycle.generation,Date.now()).run()
      row = (await byOperation(env, site.id, input.operationId))!
    }
    const operation = row
    const result = await backend.execute(site,input,artifact,lease,async result => {
      await env.WORDPRESS_STATE_DATABASE.prepare("UPDATE wp_codebox_native_operations SET prepared_json=? WHERE site_id=? AND operation_id=?").bind(JSON.stringify(result),site.id,input.operationId).run()
    })
    const terminal = await coordinator.commit(lease,result.pointer)
    committed = true
    if (terminal.version !== result.receipt.revision_receipt.canonical_state_version) throw new Error("Native commit version mismatch.")
    await finish(env,operation,result.receipt)
    return resource((await byOperation(env,site.id,input.operationId))!)
  } catch (cause) {
    if (row && !committed) await env.WORDPRESS_STATE_DATABASE.prepare("UPDATE wp_codebox_native_operations SET state='retryable',error_json=? WHERE site_id=? AND operation_id=?").bind(JSON.stringify({code:cause instanceof RevisionConflict?"stale_revision":"native_runtime_error",message:message(cause)}),site.id,input.operationId).run()
    return error(cause instanceof RevisionConflict?409:422,cause instanceof RevisionConflict?"stale_revision":"native_runtime_error",message(cause))
  } finally { if (lease && !committed) await coordinator.abort(lease) }
}

async function stage(request:Request,env:NativeEnv,hash:string):Promise<Response>{
  if(request.method!=="PUT")return error(405,"method_not_allowed","PUT is required.")
  const token=await authenticateProvisioningRequest(request,env,"sites:create");if(token instanceof Response)return token
  const key=provisioningIdempotencyKey(request);if(key instanceof Response)return key
  try{
    const bytes=await readBoundedRequestBytes(request,MAX_NATIVE_BRICKS_ARTIFACT_BYTES)
    if(await sha256Hex(bytes)!==hash)return error(409,"artifact_digest_mismatch","Native artifact SHA does not match its bytes.")
    const artifact=await validateNativeBricksArtifact(bytes)
    if(!provisioningTokenAllowsSite(token,artifact.site.site_id))return error(404,"not_found","Allocation unavailable.")
    const r2Key=artifactKey(hash)
    await env.WORDPRESS_STATE_BUCKET.put(r2Key,bytes,{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:"application/json"}})
    const object=await env.WORDPRESS_STATE_BUCKET.get(r2Key)
    if(!object||object.size!==bytes.byteLength||await sha256Hex(new Uint8Array(await object.arrayBuffer()))!==hash)return error(409,"artifact_conflict","Immutable native artifact conflicts.")
    return Response.json({schema:"wp-codebox/provisioning-artifact/v1",artifact:{sha256:hash,size:bytes.byteLength,r2Key}})
  }catch(cause){return error(400,"invalid_native_artifact",message(cause))}
}
export function validateNativeMutation(input:NativeMutation,action:string,key:string):void{
  if(!input||input.schema!=="wp-codebox/native-bricks-mutation-request/v1"||input.action!==action||input.idempotencyKey!==key||!id.test(input.operationId)||!id.test(input.customerId)||!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.siteId)||input.siteId.length>63||!input.authority||!input.targetRequest)throw new Error("Native request identity is invalid.")
  const t=input.targetRequest
  if(t.operation_id!==input.operationId||t.idempotency_key!==key||t.site_id!==input.siteId||t.customer_id!==input.customerId||t.target_runtime!=="wordpress_bricks_cloudflare_v1")throw new Error("Target request identity mismatch.")
  const empty = {receipt_id:null,canonical_state_version:null,canonical_state_revision:null,canonical_manifest_key:null,canonical_persisted_at:null,artifact_sha256:null,native_document_hashes:null,design_system_version:null}
  const {required,...rollback}=t.rollback_receipt??{}
  if(t.schema_version!==1||t.bricks_artifact?.version!=="wp-codebox/bricks-site-artifact/v1"||t.license_secret_ref!=="BRICKS_LICENSE_KEY"||required!==true||stableJson(t.revision_receipt)!==stableJson(input.authority.expectedBase??empty)||stableJson(rollback)!==stableJson(input.authority.restoreTarget??input.authority.expectedBase??empty))throw new Error("Target request exact authority mismatch.")
  if(!Array.isArray(t.authorized_assets)||t.authorized_assets.some((asset:any)=>asset.usage_status!=="approved"||!digest.test(asset.sha256)))throw new Error("Native assets must be agency-approved.")
  if(action==="provision"&&(input.authority.expectedBase!==null||input.authority.restoreTarget!==null))throw new Error("Provision authority must be empty.")
  if(action!=="provision")validatePointer(input.authority.expectedBase)
  if(action==="restore"){validatePointer(input.authority.restoreTarget);if(input.artifact!==null)throw new Error("Restore uses the retained revision, not a new artifact.")}
  else{if(input.authority.restoreTarget!==null||!input.artifact||!digest.test(input.artifact.sha256)||input.artifact.r2Key!==artifactKey(input.artifact.sha256)||!Number.isSafeInteger(input.artifact.size)||input.artifact.size<1||input.artifact.size>MAX_NATIVE_BRICKS_ARTIFACT_BYTES)throw new Error("Native staged artifact reference is invalid.")}
}
function validatePointer(value:NativePointer|null):void{if(!value||!id.test(value.receipt_id)||!Number.isSafeInteger(value.canonical_state_version)||value.canonical_state_version<1||!value.canonical_state_revision||!value.canonical_manifest_key||!Number.isFinite(Date.parse(value.canonical_persisted_at))||!digest.test(value.artifact_sha256)||!Array.isArray(value.native_document_hashes)||!value.native_document_hashes.length||value.native_document_hashes.some(hash=>!digest.test(hash))||!value.design_system_version)throw new Error("Exact content-bound pointer is required.")}
function artifactKey(hash:string):string{return `sites/provisioning/bricks-artifacts/${hash}.json`}
function sameManifest(a:MarkdownPointer|null,b:MarkdownPointer):boolean{return !!a&&a.revision===b.revision&&a.manifestKey===b.manifestKey&&a.persistedAt===b.persistedAt}
function pointerMatchesLease(pointer:NativePointer,lease:RevisionLease):boolean{return pointer.canonical_state_version===lease.version&&sameManifest(lease.pointer,{revision:pointer.canonical_state_revision,manifestKey:pointer.canonical_manifest_key,persistedAt:pointer.canonical_persisted_at})}
function error(status:number,code:string,message:string):Response{return Response.json({schema,error:{code,message}},{status})}
function message(cause:unknown):string{
  if(!(cause instanceof Error))return "Native operation failed."
  if(cause.message.startsWith("PHP.run()")){
    const vendor=cause.message.match(/Uncaught Exception: ([^\n]+)/)?.[1]
    return vendor ? vendor.replace(/<[^>]*>/g,"").split(" | data:")[0].slice(0,400) : "Native PHP execution failed."
  }
  return cause.message.slice(0,400)
}
function resource(row:OperationRow):Response{return Response.json({schema,operation:{id:row.operation_id,siteId:row.site_id,state:row.state,stage:row.state==="succeeded"?"prepared-allocation-native-documents-committed":"native-mutation",progress:row.state==="succeeded"?100:0,retryAt:null,error:row.error_json?JSON.parse(row.error_json):null,receipt:row.receipt_json?JSON.parse(row.receipt_json):null}})}
async function byOperation(env:NativeEnv,site:string,op:string):Promise<OperationRow|null>{return env.WORDPRESS_STATE_DATABASE.prepare("SELECT * FROM wp_codebox_native_operations WHERE site_id=? AND operation_id=?").bind(site,op).first<OperationRow>()}
async function finish(env:NativeEnv,row:OperationRow,receipt:Record<string,any>):Promise<void>{await env.WORDPRESS_STATE_DATABASE.prepare("UPDATE wp_codebox_native_operations SET state='succeeded',receipt_json=?,committed_version=?,error_json=NULL WHERE site_id=? AND operation_id=?").bind(JSON.stringify(receipt),receipt.revision_receipt.canonical_state_version,row.site_id,row.operation_id).run()}
function initialize(env:NativeEnv):Promise<void>{let promise=ready.get(env.WORDPRESS_STATE_DATABASE);if(!promise){promise=env.WORDPRESS_STATE_DATABASE.exec("CREATE TABLE IF NOT EXISTS wp_codebox_native_operations(site_id TEXT NOT NULL,operation_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,principal TEXT NOT NULL,fingerprint TEXT NOT NULL,input_json TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL,created_at INTEGER NOT NULL,prepared_json TEXT,receipt_json TEXT,error_json TEXT,committed_version INTEGER,PRIMARY KEY(site_id,operation_id),UNIQUE(site_id,idempotency_key));").then(()=>{});ready.set(env.WORDPRESS_STATE_DATABASE,promise)}return promise}
