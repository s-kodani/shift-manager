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
