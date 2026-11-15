async (page) => {
 const tables=[];
 for(let i=0;i<3;i++)for(const mode of ['baseline','indexed']){
  await page.getByRole('button',{name:mode==='baseline'?'変更前を表示':'変更後を表示',exact:true}).click();
  await page.waitForFunction(()=>window.measurements.at(-1)?.displayMilliseconds!==null);
  const hash=await page.evaluate(async()=>{
   const rows=[...document.querySelectorAll('tbody tr')].map(row=>({name:row.querySelector('th').textContent,cells:[...row.querySelectorAll('td button')].map(b=>[b.textContent,b.getAttribute('aria-label'),b.className])}));
   const bytes=new TextEncoder().encode(JSON.stringify(rows));
   return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  });tables.push({mode,hash});
 }
 return await page.evaluate(tables=>({measurements:window.measurements,tableHashes:tables,viewport:{width:innerWidth,height:innerHeight},userAgent:navigator.userAgent,scope:'development fresh component mount/commit and two subsequent frames; prior root unmount recorded separately; actual isolated Mac solver fixture; no registration, API/auth, Queues or full-product timing'}),tables);
}
