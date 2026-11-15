async(page)=>{
 await page.getByRole('button',{name:'境界ケースを表示',exact:true}).click();
 const work=page.getByRole('button',{name:'架空勤務 2026-10-01 勤務詳細',exact:true});
 if((await work.textContent()).replace(/\s/g,'')!=='09:0012:00')throw Error('WORK_CELL_CHANGED');
 if(await page.getByRole('button',{name:'架空休日 2026-10-01 勤務詳細',exact:true}).textContent()!=='休日')throw Error('HOLIDAY_CHANGED');
 if(await page.locator('tbody tr').nth(2).locator('td').first().innerText()!=='未確認'||await page.getByRole('button',{name:'架空未確認 2026-10-01 勤務詳細',exact:true}).count()!==0)throw Error('MISSING_CHANGED');
 await work.click();if(await page.locator('#status').textContent()!=='日別配置 2026-10-01')throw Error('DATE_NAVIGATION_CHANGED');
 await page.getByRole('button',{name:'スタッフ名を更新',exact:true}).click();
 if(await page.getByRole('button',{name:'変更後の架空名 2026-10-01 勤務詳細',exact:true}).count()!==1)throw Error('NAME_CACHE_STALE');
 await page.getByRole('button',{name:'対象月を変更',exact:true}).click();
 if(await page.locator('thead th').count()!==30)throw Error('LEAP_MONTH_WRONG');
 if(await page.locator('tbody tr').first().locator('td').last().innerText()!=='未確認'||await page.getByRole('button',{name:'2028-02-29 日別業務配置',exact:true}).count()!==1)throw Error('MONTH_CACHE_STALE');
 await page.getByRole('button',{name:'案なしを表示',exact:true}).click();
 if(await page.getByText('この計算では勤務案を得られていません。',{exact:true}).count()!==1||await page.locator('table').count()!==0)throw Error('NO_RESULT_CHANGED');
 return {work:true,holiday:true,missing:true,dayCallback:true,renamedAria:true,leapMonth:true,noResult:true,scope:'real MonthlyTable component props and callback; not full app daily navigation or auth'};
}
