import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const [preparedPath, buildPath] = process.argv.slice(2);
if (!preparedPath || !buildPath) throw new Error('Usage: tsx scripts/native-bricks-build-interop.mts PREPARED_DIR BUILD_SOURCE_DIR');
const directory = resolve(preparedPath), build = resolve(buildPath);
const load = (file: string) => import(pathToFileURL(resolve(build,file)).href);
const { WordPressBricksCloudflareWriter } = await load('src/product/runtime/wordpress-bricks-cloudflare-writer.ts');
const { createWordPressBricksSiteArtifact } = await load('src/product/engine/wordpress-bricks-site-artifact.ts');
const { nativeFixtureArtifact, emptyContentPointer } = await load('tests/unit/product-engine-wordpress-bricks-fixtures.ts');
const prepared = JSON.parse(await readFile(`${directory}/prepared.json`,'utf8'));
const credentials = JSON.parse(await readFile(`${directory}/credentials.json`,'utf8'));
const siteId=prepared.siteId ?? 'default';
const origin = process.env.NATIVE_API_ORIGIN ?? prepared.origin ?? 'http://127.0.0.1:8810';
const buildCommit = prepared.build_commit ?? execFileSync('git',['-C',build,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if (!prepared.build_commit) await writeFile(`${directory}/prepared.json`,JSON.stringify({...prepared,build_commit:buildCommit},null,2));
const fixture = JSON.parse(new TextDecoder().decode((await nativeFixtureArtifact()).bytes));
const strip = ({sha256, ...value}: any) => value;
const candidate = strip(fixture); delete candidate.schema;
candidate.site.site_id=siteId; candidate.runtime=prepared.runtime;
candidate.evidence_inputs.creative_provenance.canonicalCommit=buildCommit;
candidate.documents.pages=candidate.documents.pages.map((value:any)=>({...strip(value),status:'publish'}));
candidate.documents.templates=candidate.documents.templates.map((value:any)=>({...strip(value),status:'publish'}));
candidate.design_system.global_classes=candidate.design_system.global_classes.map(strip);
candidate.design_system.global_variables=candidate.design_system.global_variables.map(strip);
candidate.design_system.theme_style=strip(candidate.design_system.theme_style);
candidate.assets=candidate.assets.map(({sha256,bytes,...value}:any)=>value);
const first = await createWordPressBricksSiteArtifact(candidate);
candidate.documents.pages[0].title='Native API revised heading';
candidate.documents.pages[0].elements[0].children[0].children[0].settings.text='Native API revised heading';
const second = await createWordPressBricksSiteArtifact(candidate);
const writer = new WordPressBricksCloudflareWriter({baseUrl:'https://native-operator-rehearsal.invalid',bearerToken:credentials.apiToken,fetcher:async(request:Request)=>{
 const url=new URL(request.url); const response=await fetch(new Request(origin+url.pathname+url.search,request));
 if(!response.ok) await writeFile(`${directory}/last-http-error.json`,JSON.stringify({status:response.status,path:url.pathname,body:(await response.clone().text()).slice(0,12000)},null,2));
 return response;
}});
const results:any[]=[];
function request(action:string, artifact:any, base:any=null, restore:any=null,suffix=action){
 const doc=JSON.parse(new TextDecoder().decode(artifact.bytes));const op=`${process.env.NATIVE_API_RUN_ID ?? "build_native_v3"}_${suffix}`;
 return {schema_version:1,target_runtime:'wordpress_bricks_cloudflare_v1',operation_id:op,idempotency_key:op,site_id:siteId,customer_id:doc.site.customer_id,bricks_artifact:{version:doc.schema,sha256:artifact.sha256},runtime_artifact:prepared.runtime,dossier:doc.evidence_inputs.dossier,creative_provenance:doc.evidence_inputs.creative_provenance,authorized_assets:doc.evidence_inputs.authorized_asset_hashes.map((sha256:string)=>({sha256,usage_status:'approved'})),starter_id:doc.site.starter_id,editing:doc.editing,license_secret_ref:'BRICKS_LICENSE_KEY',revision_receipt:base??emptyContentPointer(),rollback_receipt:{required:true,...(restore??base??emptyContentPointer())},protected_preview:{state:'requested',access:'agency_managed',url:null}};
}
async function run(action:string,artifact:any,base:any=null,target:any=null){
 const input=request(action,artifact,base,target);
 const result=action==='restore'?await writer.restore(input):await writer[action](input,artifact);
 const replay=action==='restore'?await writer.restore(input):await writer[action](input,artifact);
 if(JSON.stringify(result)!==JSON.stringify(replay))throw new Error('Replay changed terminal operation');
 const polled=await writer.readOperation(action,input);
 if(JSON.stringify(result)!==JSON.stringify(polled))throw new Error('Poll changed terminal operation');
 const html=await fetch(origin+'/').then(response=>response.text());
 const heading=action==='revise'?'Native API revised heading':'A brighter home';
 if(!html.includes(heading))throw new Error('Actual public native render omitted expected heading');
 results.push({action,request:input,operation:result.operation,public_heading_observed:heading,idempotent_replay:true,poll_verified:true});
 await writeFile(`${directory}/build-interop-progress.json`,JSON.stringify({buildCommit,origin,results},null,2));
 console.log(JSON.stringify({action,state:result.operation.state,version:result.operation.receipt.revision_receipt.canonical_state_version}));
 return result.operation.receipt;
}
await writeFile(`${directory}/build-artifact.json`,first.bytes);
const provisioned=await run('provision',first);
const revised=await run('revise',second,provisioned.revision_receipt);
let staleRejected=false;
try {await writer.revise(request('revise',first,provisioned.revision_receipt,null,'stale'),first);}catch(error:any){if(error.status!==409)throw error;staleRejected=true;}
if(!staleRejected)throw new Error('Stale base was accepted');
const restored=await run('restore',first,revised.revision_receipt,provisioned.revision_receipt);
await writeFile(`${directory}/build-interop.json`,JSON.stringify({status:'real-local-native-provision-revise-restore-passed',buildCommit,origin,staleRejected,results},null,2)+'\n');
console.log('Build producer and writer verified real PHP native provision, revision, stale rejection, restore, replay and public observation.');
