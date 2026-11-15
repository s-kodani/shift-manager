import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForOwnedContainerRemoval} from '../../scripts/owned-container-cleanup.mjs';

test('cleanup waits for delayed automatic removal instead of failing immediately after stop',async()=>{
 let current=0,observations=0;
 await waitForOwnedContainerRemoval(async()=>++observations<3?'fictional-owned-id':'',{
  timeoutMs:500,now:()=>current,sleep:async ms=>{current+=ms;},
 });
 assert.equal(observations,3);assert.equal(current,200);
});
test('a container still listed at the deadline cannot produce a successful cleanup receipt',async()=>{
 let current=0;
 await assert.rejects(waitForOwnedContainerRemoval(async()=>'fictional-owned-id',{
  timeoutMs:200,now:()=>current,sleep:async ms=>{current+=ms;},
 }),/OWNED_CONTAINER_REMOVAL_UNCONFIRMED/);
});
test('an observation failure is not treated as an absent container',async()=>{
 await assert.rejects(waitForOwnedContainerRemoval(async()=>{throw Error('DOCKER_LOOKUP_FAILED');}),/DOCKER_LOOKUP_FAILED/);
});
