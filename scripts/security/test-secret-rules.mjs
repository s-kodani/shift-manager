import assert from 'node:assert/strict';
import {randomInt} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
function syntheticHex(){const a=[...'0123456789abcdef'.repeat(4)];for(let i=a.length-1;i>0;i--){const n=randomInt(i+1);[a[i],a[n]]=[a[n],a[i]];}return a.join('');}
await mkdir('.cache',{recursive:true});const directory=await mkdtemp(path.resolve('.cache/secret-rules-'));
try{
 await writeFile(directory+'/synthetic.txt',`API_KEY = "${syntheticHex()}"\n`);
 await writeFile(directory+'/synthetic.json',JSON.stringify({access_token:syntheticHex()}));
 await writeFile(directory+'/image.json',JSON.stringify({sha256:syntheticHex()}));
 const report=directory+'/report.json';
 const r=spawnSync(path.resolve('.cache/security-bin/gitleaks'),['dir',directory,'--config',path.resolve('.gitleaks.toml'),'--redact=100','--report-format','json','--report-path',report],{encoding:'utf8'});
 assert.equal(r.status,1,'Synthetic credential patterns must be detected');const findings=JSON.parse(await readFile(report));
 assert.deepEqual(findings.map(f=>path.basename(f.File)).sort(),['synthetic.json','synthetic.txt']);
 console.log('Gitleaks detects both synthetic credential patterns and permits a normal digest');
}finally{await rm(directory,{recursive:true,force:true});}
