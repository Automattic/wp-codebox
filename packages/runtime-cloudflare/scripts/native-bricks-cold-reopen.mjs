import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium} from 'playwright';
const directory=resolve(process.argv[2]);
const evidence=resolve(process.argv[3]);
const {apiToken}=JSON.parse(await readFile(`${directory}/credentials.json`,'utf8'));
const proof=JSON.parse(await readFile(`${directory}/build-interop.json`,'utf8'));
const restored=proof.results.find(result=>result.action==='restore').operation;
const response=await fetch(`${proof.origin}/v1/sites/${restored.siteId}/operations/${restored.id}`,{headers:{authorization:`Bearer ${apiToken}`}});
const current=await response.json();
if(response.status!==200||JSON.stringify(current.operation)!==JSON.stringify(restored))throw new Error('Cold operation receipt changed');
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({headless:true});
const observations=[];
for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]){
 const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
 const response=await page.goto(proof.origin+'/',{waitUntil:'networkidle'});
 const observed=await page.evaluate(()=>({heading:document.querySelector('h1')?.textContent,nativeElements:document.querySelectorAll('[id^="brxe-"]').length,images:[...document.images].map(image=>({src:image.currentSrc,loaded:image.complete&&image.naturalWidth>0,width:image.naturalWidth})),overflow:document.documentElement.scrollWidth>innerWidth}));
 if(response.status()!==200||observed.heading!=='A brighter home'||!observed.nativeElements||!observed.images.length||observed.images.some(image=>!image.loaded)||observed.overflow)throw new Error('Cold native render failed '+JSON.stringify(observed));
 await page.screenshot({path:`${evidence}/${name}.png`,fullPage:true});
 observations.push({viewport:name,status:response.status(),...observed,screenshot_sha256:createHash('sha256').update(await readFile(`${evidence}/${name}.png`)).digest('hex')});
 await page.close();
}
await browser.close();
await writeFile(`${evidence}/cold-reopen.json`,JSON.stringify({status:'cold-native-receipt-and-public-render-passed',origin:proof.origin,restored_revision:restored.receipt.revision_receipt,observations,qualification:'Programmatic native API proof only; licensed visual editor not run.'},null,2)+'\n');
console.log(JSON.stringify({status:'cold-reopen-passed',version:restored.receipt.revision_receipt.canonical_state_version,viewports:observations.map(value=>({viewport:value.viewport,nativeElements:value.nativeElements,images:value.images.length,overflow:value.overflow}))}));
