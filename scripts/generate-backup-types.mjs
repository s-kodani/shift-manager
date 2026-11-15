import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {command} from './backup-lib.mjs';
await mkdir('.cache',{recursive:true});
const temporary='.cache/backup-generated-types.d.ts';
await command('backup-binding-types',['types',temporary,'--config','infra/backup-monitor.jsonc','--env-interface','BackupMonitorEnv','--include-runtime=false']);
const text=await readFile(temporary,'utf8'),match=text.match(/interface __BaseEnv_BackupMonitorEnv \{([\s\S]*?)^\}/m);
if(!match)throw new Error('Wrangler backup binding output changed; inspect the generated type format.');
// Keep each Worker's bindings separate; merging Cloudflare.Env from two
// configurations would make unavailable bindings appear valid in the main API.
const output='// Generated from infra/backup-monitor.jsonc by Wrangler via scripts/generate-backup-types.mjs.\nexport interface BackupMonitorEnv {'+match[1]+'}\n';
const file='apps/operations/worker-configuration.d.ts';
if(process.argv.includes('--check')){if(await readFile(file,'utf8')!==output)throw new Error('Backup binding types are stale.');}
else await writeFile(file,output);
