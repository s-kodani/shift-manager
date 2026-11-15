// Controlled services and synthetic review/check records. No remote acceptance.
import {observationFixture} from './final-cohort-observation.mjs';
import {observeFinalCohort} from '../../../scripts/final-cohort-observation.mjs';
import {freezeFinalRelease} from '../../../scripts/final-release-freeze.mjs';
export async function frozenCohortFixture(work){return observationFixture(async f=>{
 await observeFinalCohort(f.root,{...f.options,request:f.request,registry:f.registry});
 const frozen=await freezeFinalRelease(f.root,{inspectSource:f.options.inspectSource});
 return work({...f,frozen});
});}
