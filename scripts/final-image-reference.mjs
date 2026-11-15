import {deploymentTarget} from './deployment-target.mjs';
import path from 'node:path';
import assert from 'node:assert/strict';
export function finalImageTag(root){const id=path.basename(root);assert.match(id,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);return 'shift-planner-final-'+id.replaceAll('-','').slice(0,12)+':candidate';}
export function finalImageReference(root){return 'registry.cloudflare.com/'+deploymentTarget.accountId+'/'+finalImageTag(root);}
