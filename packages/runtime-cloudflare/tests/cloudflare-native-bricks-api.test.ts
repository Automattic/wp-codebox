import test from 'node:test'
import assert from 'node:assert/strict'
import { validateNativeMutation, type NativeMutation } from '../src/native-bricks-api.js'
const hash='a'.repeat(64)
const empty={receipt_id:null,canonical_state_version:null,canonical_state_revision:null,canonical_manifest_key:null,canonical_persisted_at:null,artifact_sha256:null,native_document_hashes:null,design_system_version:null}
const pointer={receipt_id:'receipt_1',canonical_state_version:1,canonical_state_revision:'revision-1',canonical_manifest_key:'sites/default/revision-1.json',canonical_persisted_at:'2026-09-10T00:00:00.000Z',artifact_sha256:hash,native_document_hashes:[hash],design_system_version:'design-v1'}
function input(action:NativeMutation['action']):NativeMutation {
 const base=action==='provision'?null:pointer, target=action==='restore'?{...pointer,canonical_state_version:2}:null
 return {schema:'wp-codebox/native-bricks-mutation-request/v1',action,idempotencyKey:'operation_1',operationId:'operation_1',siteId:'default',customerId:'customer_1',artifact:action==='restore'?null:{sha256:hash,size:10,r2Key:`sites/provisioning/bricks-artifacts/${hash}.json`},authority:{expectedBase:base,restoreTarget:target},targetRequest:{schema_version:1,target_runtime:'wordpress_bricks_cloudflare_v1',operation_id:'operation_1',idempotency_key:'operation_1',site_id:'default',customer_id:'customer_1',bricks_artifact:{version:'wp-codebox/bricks-site-artifact/v1',sha256:hash},license_secret_ref:'BRICKS_LICENSE_KEY',authorized_assets:[{sha256:hash,usage_status:'approved'}],revision_receipt:base??empty,rollback_receipt:{required:true,...(target??base??empty)}}}
}
test('native authority binds exact Build pointer and restore target',()=>{
 for(const action of ['provision','revise','restore'] as const)assert.doesNotThrow(()=>validateNativeMutation(input(action),action,'operation_1'))
 const changed=input('revise');changed.targetRequest.revision_receipt={...pointer,native_document_hashes:['b'.repeat(64)]};assert.throws(()=>validateNativeMutation(changed,'revise','operation_1'),/exact authority/)
 const restore=input('restore');restore.targetRequest.rollback_receipt={required:true,...pointer};assert.throws(()=>validateNativeMutation(restore,'restore','operation_1'),/exact authority/)
})
test('native admission rejects foreign staging keys, non-approved assets and mismatched identities',()=>{
 const wrong=input('provision');wrong.artifact!.r2Key='sites/another-site/private.json';assert.throws(()=>validateNativeMutation(wrong,'provision','operation_1'),/staged artifact/)
 const unsafe=input('provision');unsafe.targetRequest.authorized_assets[0].usage_status='pending';assert.throws(()=>validateNativeMutation(unsafe,'provision','operation_1'),/agency-approved/)
 const mismatch=input('provision');mismatch.targetRequest.site_id='another-site';assert.throws(()=>validateNativeMutation(mismatch,'provision','operation_1'),/identity mismatch/)
})
