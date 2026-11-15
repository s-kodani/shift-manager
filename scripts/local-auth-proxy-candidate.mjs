// Experimental isolated local-only copy; installed dependencies stay untouched.
import {cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
export const PROXY_VERSION='4.149.0';
export const PROXY_SHA='703358e6194e2323d1c40cf7d35c954b480496d69bf9d23df72cfcab308c13d9';
const anchor='      const attemptUserWorkerFetch = (attempt = 0) => void fetch(userWorkerUrl, new Request(request, { headers })).then(';
export function patchLocalProxy(source,version){
 assert.equal(version,PROXY_VERSION,'LOCAL_PROXY_VERSION_CHANGED');
 assert.equal(createHash('sha256').update(source).digest('hex'),PROXY_SHA,'LOCAL_PROXY_SOURCE_CHANGED');
 assert.equal(source.split(anchor).length,2,'LOCAL_PROXY_ANCHOR_CHANGED');
 return source.replace(anchor,`      // Project local diagnostic: disable reuse on the internal loopback hop only.
      if (userWorkerUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(userWorkerUrl.hostname)) {
        headers.set("Connection", "close");
      }
${anchor}`);
}
export async function prepareLocalProxyCandidate(root){
 const source=path.resolve('node_modules/wrangler'),version=JSON.parse(await readFile(source+'/package.json')).version;
 const original=await readFile(source+'/wrangler-dist/ProxyWorker.js','utf8');
 const patched=patchLocalProxy(original,version),target=path.join(root,'node_modules/wrangler');
 await mkdir(path.dirname(target),{recursive:true,mode:0o700});
 await cp(source,target,{recursive:true,errorOnExist:true,force:false});
 await writeFile(target+'/wrangler-dist/ProxyWorker.js',patched,{mode:0o600});
 return {cli:target+'/bin/wrangler.js',version,originalSha256:PROXY_SHA,patchedSha256:createHash('sha256').update(patched).digest('hex')};
}
