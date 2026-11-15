async(page)=>{
 await page.waitForFunction(()=>window.measurements.at(-1)?.displayMilliseconds!==null);
 const before=await page.evaluate(()=>{const content=document.querySelector('.content'),panel=document.querySelector('.panel'),scroller=document.querySelector('.table-scroll'),button=document.querySelector('tbody td button');return {viewport:innerWidth,pageWidth:document.documentElement.scrollWidth,contentPadding:getComputedStyle(content).padding,panelPadding:getComputedStyle(panel).padding,tableScrollerWidth:scroller.clientWidth,tableScrollWidth:scroller.scrollWidth,buttonHeight:button.getBoundingClientRect().height,rows:document.querySelectorAll('tbody tr').length,cells:document.querySelectorAll('tbody td').length}});
 if(before.viewport!==390||before.pageWidth>before.viewport||before.rows!==500||before.cells!==15500)throw Error('MOBILE_LAYOUT_INVALID');
 await page.getByRole('button',{name:'架空スタッフ0500 2026-10-31 勤務詳細',exact:true}).click();
 if(await page.locator('#status').textContent()!=='日別配置 2026-10-31')throw Error('LAST_ROW_CALLBACK_INVALID');
 return {...before,lastRowDateCallback:true,scope:'component fixture with product CSS; not authenticated product mobile route'};
}
