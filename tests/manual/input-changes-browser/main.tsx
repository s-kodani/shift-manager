// Component acceptance with a controlled API; no credentials, DB or solver.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InputChanges } from '../../../apps/web/product/input-changes';
import '../../../apps/web/product/style.css';
let conflict=false,unavailable=false;
const snapshotId='00000000-0000-4000-8000-000000000001',staffId='00000000-0000-4000-8000-000000000002';
const changes=[
  {path:['sources','staff_contract',staffId],before:7,after:10},
  {path:['staff',staffId,'contract','end'],before:1020,after:1080},
  {path:['resources','staff_contract',staffId,'rule','dailyMax'],before:420,after:390},
  {path:['staff',staffId,'preferences','2026-10-01:window','end'],before:1020,after:990},
  {path:['staff',staffId,'unavailable','2026-10-02::607','start'],after:607},
  ...Array.from({length:50},(_,i)=>({path:['demand',`2026-10-${String(Math.floor(i/2)+1).padStart(2,'0')}:phone:${600+(i%2)*30}`,'direct'],before:null,after:0})),
].map(row=>({...row,beforeTruncated:false,afterTruncated:false}));
globalThis.fetch=async(input)=>{
  const url=new URL(String(input),location.origin);
  if(!url.pathname.endsWith('/changes'))throw Error('FIXTURE_ONLY');
  if(conflict)return Response.json({error:'VERSION_CONFLICT'},{status:409});
  const offset=Number(url.searchParams.get('offset'));
  const selected=unavailable?changes.filter(c=>['sources','resources'].includes(c.path[0])):changes;
  return Response.json({snapshotId,month:'2026-10',inputRevision:9,currentRevision:Number(url.searchParams.get('expectedRevision')),
    sourceDraftRevision:0,currentDraftRevision:0,currentInputStatus:unavailable?'UNAVAILABLE':'COMPILED',currentInputError:unavailable?'CONTRADICTORY_RULE':null,
    changes:selected.slice(offset,offset+50),total:selected.length,totals:{input:selected.length,publication:0},offset,nextOffset:offset+50<selected.length?offset+50:null});
};
function App(){const [error,setError]=useState('');return <main style={{maxWidth:1100,margin:'24px auto',padding:'0 20px'}}>
  <h1>入力変更の確認</h1><p>架空データ・制御APIによる表示検証</p>
  <div className="toolbar"><button onClick={()=>{conflict=true;}}>版競合を発生</button><button onClick={()=>{unavailable=true;}}>組み立て不能にする</button><button onClick={()=>{conflict=false;unavailable=false;setError('');}}>正常応答へ戻す</button></div>
  {error&&<p role="status">{error}</p>}
  <InputChanges base="/api/fixture/inputs/teams/local" snapshotId={snapshotId} revision={12} draftRevision={0} nameOf={()=>'架空スタッフ（0001）'} report={e=>setError(e instanceof Error?e.message:String(e))}/>
</main>;}
createRoot(document.getElementById('root')!).render(<App/>);
