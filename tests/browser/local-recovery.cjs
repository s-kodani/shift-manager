// Run after a fresh restored-fixture snapshot and real UI login. No credentials.
async (page) => {
 const url=new URL(page.url());if(url.origin!=='http://localhost:8787'||url.pathname!=='/app')throw Error('Owned local restored fixture only');
 await page.getByRole('heading',{name:'公開済みのシフト',exact:true}).waitFor();
 const results=[];
 for(const [kind,width,height] of [['pc',1440,1000],['mobile',390,844]]){
  await page.setViewportSize({width,height});
  await page.getByRole('link',{name:'公開済み勤務のCSVをダウンロード',exact:true}).waitFor();
  const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,mainPaddingLeft:parseFloat(getComputedStyle(document.querySelector('main')).paddingLeft),mainPaddingRight:parseFloat(getComputedStyle(document.querySelector('main')).paddingRight)}));
  if(metrics.scrollWidth>width||metrics.mainPaddingLeft<16||metrics.mainPaddingRight<16)throw Error('Restored UI spacing or overflow');
  const r=await page.evaluate(async()=>{const u=new URL(location.href),company=u.searchParams.get('company'),team=u.searchParams.get('team');const response=await fetch(`/api/companies/${company}/schedules/teams/${team}/publications?month=2026-10`);const p=await response.json();return {status:response.status,revision:p.publicationRevision};});
  if(r.status!==200||r.revision!==1)throw Error('Restored publication missing');
  await page.screenshot({path:`artifacts/local-recovery-restored-${kind}.png`,fullPage:false});
  results.push({kind,...metrics,...r});
 }
 return {restoredPublicationVisible:true,results};
}
