import {setTimeout} from 'node:timers/promises';

// docker stop may return before --rm finishes removing the owned container.
// Nonempty/failed observations never count as confirmed cleanup.
export async function waitForOwnedContainerRemoval(observe,{timeoutMs=10_000,now=Date.now,sleep=setTimeout}={}){
 const deadline=now()+timeoutMs;
 while(true){
  if(await observe()==='')return;
  const remaining=deadline-now();
  if(remaining<=0)throw Error('OWNED_CONTAINER_REMOVAL_UNCONFIRMED');
  await sleep(Math.min(100,remaining));
 }
}

// Remove only the uniquely owned build tag after its Containers are gone.
// A shared content ID or shared proxy tag is never a deletion target.
export async function removeOwnedSdkImage({tag,expectedImageId,observe,remove}){
 if(!/^shift-planner-bounded-sdk-[a-f0-9]{12}-optimizer$/.test(tag)||!/^sha256:[a-f0-9]{64}$/.test(expectedImageId))throw Error('OWNED_IMAGE_IDENTITY_INVALID');
 const current=await observe(tag);
 if(current==='')return;
 if(current!==expectedImageId)throw Error('OWNED_IMAGE_ID_CHANGED');
 await remove(tag);
 if(await observe(tag)!=='')throw Error('OWNED_IMAGE_REMOVAL_UNCONFIRMED');
}
