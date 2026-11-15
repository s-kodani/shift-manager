import test from 'node:test';
import assert from 'node:assert/strict';
import {removeOwnedSdkImage} from '../../scripts/owned-container-cleanup.mjs';
const tag='shift-planner-bounded-sdk-012345abcdef-optimizer',id='sha256:'+'a'.repeat(64);
test('only the owned SDK tag is removed; the content ID and shared proxy remain untouched',async()=>{
 const calls=[];let current=id;await removeOwnedSdkImage({tag,expectedImageId:id,observe:async t=>{assert.equal(t,tag);return current;},remove:async t=>{calls.push(t);current='';}});assert.deepEqual(calls,[tag]);
});
test('an already absent tag is confirmed without a deletion',async()=>{let calls=0;await removeOwnedSdkImage({tag,expectedImageId:id,observe:async()=>'',remove:async()=>calls++});assert.equal(calls,0);});
test('a changed content ID preserves the tag and fails',async()=>{let calls=0;await assert.rejects(removeOwnedSdkImage({tag,expectedImageId:id,observe:async()=>'sha256:'+'b'.repeat(64),remove:async()=>calls++}),/CHANGED/);assert.equal(calls,0);});
test('a failed deletion or remaining tag cannot claim successful cleanup',async()=>{
 await assert.rejects(removeOwnedSdkImage({tag,expectedImageId:id,observe:async()=>id,remove:async()=>{throw Error('delete failed');}}));
 await assert.rejects(removeOwnedSdkImage({tag,expectedImageId:id,observe:async()=>id,remove:async()=>{}}),/UNCONFIRMED/);
});
test('foreign, shared and bare content-ID targets fail before observation',async()=>{
 let calls=0;for(const t of ['cloudflare/proxy-everything:shared','other-image',id])await assert.rejects(removeOwnedSdkImage({tag:t,expectedImageId:id,observe:async()=>{calls++;return id;},remove:async()=>{}}));assert.equal(calls,0);
});
