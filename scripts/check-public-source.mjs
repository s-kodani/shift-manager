import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
const files=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
assert(files.length>0,'TRACKED_PUBLIC_SOURCE_REQUIRED');
for(const f of files){
 assert(!/^(?:\.cache|artifacts|output|dist|node_modules|docs\/mock|docs\/mvp\/evidence|docs\/mvp\/screenshots)\//.test(f),'PRIVATE_OR_GENERATED_FILE_TRACKED');
 assert(!/(?:^|\/)\.dev\.vars(?:\.[^.]+)?$/.test(f)||f.endsWith('.example'),'SECRET_FILE_TRACKED');
 if(!/\.(?:png|jpg|jpeg|gif)$/.test(f)){
  const text=await readFile(f,'utf8');assert(!/\/Users\/[A-Za-z0-9._-]+\//.test(text),'PERSONAL_PATH_IN_PUBLIC_SOURCE');
 }
}
const pkg=JSON.parse(await readFile('package.json'));assert.equal(pkg.license,'Apache-2.0');assert.equal(pkg.private,true);
assert.equal(pkg.repository.url,'https://github.com/s-kodani/shift-manager.git');
console.log('Public source: no tracked private artifacts, secret files or personal paths');
