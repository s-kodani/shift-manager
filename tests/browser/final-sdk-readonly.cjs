async(page,owner)=>{
 const f=owner.fixtures,jar=owner.jar,token=owner.token,output=owner.output;
 const base=owner.base??'http://localhost:8787',origin=new URL(base).origin;
 const writes=[],errors=[],blocked=[];page.on('request',r=>{if(r.method()!=='GET'&&r.method()!=='HEAD')writes.push({method:r.method(),url:r.url().split('?')[0]});});page.on('pageerror',e=>errors.push(e.name));
 await page.context().setExtraHTTPHeaders({});
 await page.context().route('**/*',async route=>{
  const req=route.request();if(new URL(req.url()).origin!==origin||!['GET','HEAD'].includes(req.method())){blocked.push({method:req.method(),url:req.url().split('?')[0]});return route.abort();}
  return route.continue({headers:{...req.headers(),authorization:'Bearer '+token}});
 });
 const result=[];
 for(const [kind,actor,width,height] of [['large','largeAdmin',1280,900],['single','singleStaff',390,844]]){
  const fixture=f[kind];await page.context().clearCookies();await page.context().addCookies(Object.entries(jar[actor]).map(([name,value])=>({name,value,url:base,httpOnly:true,sameSite:'Lax',secure:origin.startsWith('https:')})));
  await page.setViewportSize({width,height});await page.goto(base+'/app?company='+fixture.companyId+'&team='+fixture.teamId+'&month=2026-10');
  await page.getByRole('button',{name:'ログアウト',exact:true}).waitFor({timeout:30000});
  let content;
  if(actor==='largeAdmin'){
   await page.locator('.candidate-monthly .month-table').waitFor();
   await page.waitForFunction(()=>document.querySelectorAll('.candidate-monthly .month-table tbody tr').length===101,{},{timeout:30000});
   const table=page.locator('.candidate-monthly .month-table');await table.waitFor({state:'visible',timeout:30000});
   await table.evaluate(el=>window.scrollTo({top:scrollY+el.getBoundingClientRect().top-24,behavior:'instant'}));
   await page.waitForFunction(()=>{const r=document.querySelector('.candidate-monthly .month-table')?.getBoundingClientRect();return r&&r.top>=0&&r.top<100;},{},{timeout:30000});
   content={monthRows:await table.locator('tbody tr').count()};
  }else{
   await page.getByRole('heading',{name:'自分の公開済みシフト',exact:true}).waitFor({timeout:30000});
   await page.waitForFunction(()=>document.querySelectorAll('.published-day').length===31&&!document.body.innerText.includes('公開版を読み込んでいます'),{},{timeout:30000});
   content={publishedDays:await page.locator('.published-day').count()};
  }
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.screenshot({path:output+'/'+actor+'.png',fullPage:false});
  const layout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,text:document.body.innerText}));
  if(layout.document>width||!layout.text.includes('シフト'))throw Error('FINAL_READONLY_RENDER_INVALID');
  result.push({actor,width,documentWidth:layout.document,...content,rendered:true});
 }
 await page.context().unrouteAll({behavior:'wait'});
 if(writes.length||errors.length||blocked.length)throw Error('FINAL_READONLY_UNEXPECTED_WRITE_OR_PAGEERROR');
 return {result,writes,errors,blocked};
}
