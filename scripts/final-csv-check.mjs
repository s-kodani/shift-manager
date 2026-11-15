// One normal-product preview/abort/apply/receipt sequence, no calculation.
import {fingerprint} from './final-run-control.mjs';
const requireValue=(value,code)=>{if(!value)throw Error(code);};
export async function verifyFinalCsv({fixture,operationId,request,record}){
 const base=`/api/companies/${fixture.companyId}/inputs/teams/${fixture.teamId}`;
 const [year,month]=fixture.month.split('-').map(Number),date=new Date(Date.UTC(year,month,1));
 const target=date.toISOString().slice(0,7),day=target+'-02';
 const context=()=>request('/api/context');
 const revision=async()=>{const c=await context(),company=c.companies.find(c=>c.id===fixture.companyId);requireValue(company,'FINAL_CSV_COMPANY_MISSING');return company.revision;};
 const original=await request(base+'/planning/'+fixture.month),v=await revision();
 const absent=await request(base+'/planning/'+target);requireValue(absent.version===null,'FINAL_CSV_TARGET_NOT_EMPTY');
 const csv='date,start,end,task_id,direct,calculated\n'+
  `${day},10:00,10:30,phone,0,2\n${day},10:30,11:00,phone,,1\n${day},11:00,11:10,phone,1,\n`;
 const body={month:target,expectedRevision:v,csv};
 const preview=await request(base+'/demand-csv/preview',body);
 requireValue(preview.added===2&&preview.replaced===0&&preview.rows.length===3&&preview.rows[2].errors.length>0,'FINAL_CSV_PREVIEW_INVALID');
 requireValue(preview.rows[0].demand.direct===0&&preview.rows[0].demand.calculated===2*preview.capacityScale&&preview.rows[1].demand.direct===null&&preview.rows[1].demand.calculated===preview.capacityScale,'FINAL_CSV_ZERO_UNSET_OR_SCALE_CHANGED');
 const rejected=await request(base+'/demand-csv/preview',body,{staff:true,expected:403});requireValue(rejected.error==='FORBIDDEN','FINAL_CSV_STAFF_ALLOWED');
 requireValue(await revision()===v,'FINAL_CSV_ABORT_MUTATED_REVISION');
 requireValue((await request(base+'/planning/'+target)).version===null,'FINAL_CSV_ABORT_CREATED_PLANNING');
 requireValue(fingerprint((await request(base+'/planning/'+fixture.month)).version)===fingerprint(original.version),'FINAL_CSV_ABORT_CHANGED_CURRENT_MONTH');
 const command={...body,operationId,previewSha256:preview.previewSha256};
 // Persist the complete fictional command before the sole apply POST.
 await record({stage:'APPLY_DISPATCHED',operationId,command});
 const applied=await request(base+'/demand-csv/apply',command);
 const receipt=await request(base+'/demand-csv/receipts/'+operationId);
 requireValue(receipt.id===operationId&&receipt.revision===v+1&&receipt.importedRows===2&&receipt.rejectedRows===1,'FINAL_CSV_RECEIPT_MISMATCH');
 requireValue(applied.id===receipt.id&&applied.revision===receipt.revision,'FINAL_CSV_APPLY_RESPONSE_MISMATCH');
 const saved=await request(base+'/planning/'+target);
 requireValue(saved.version.payload.demand.length===2&&saved.version.payload.demand[0].direct===0&&saved.version.payload.demand[1].direct===null,'FINAL_CSV_SAVED_ROWS_INVALID');
 requireValue(fingerprint((await request(base+'/planning/'+fixture.month)).version)===fingerprint(original.version),'FINAL_CSV_APPLY_CHANGED_CURRENT_MONTH');
 const result={stage:'VERIFIED',operationId,month:target,validRows:2,rejectedRows:1,previewAbortUnchanged:true,directZero:0,unsetDirect:null,scaledCalculated:[2*preview.capacityScale,preview.capacityScale],staffPreviewStatus:403,revision:receipt.revision,applyPosts:1,receiptInspected:true,currentMonthVersionUnchanged:true};
 await record(result);return result;
}
