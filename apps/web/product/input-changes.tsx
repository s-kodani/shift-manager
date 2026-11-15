import { Button, Card, Loading, Table, TableCell, TableHead } from "./components/ui";
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { inputChangesResponse, inputChangeCategory } from '../../api/src/input-changes-contract';
import type { z } from 'zod';
import { changeLabel, changeValue } from './input-changes-model';
type Page=z.infer<typeof inputChangesResponse>;
export function InputChanges({base,snapshotId,revision,draftRevision,nameOf,report,enabled=true,embedded=false}:{
  base:string;snapshotId:string;revision:number;draftRevision:number;
  nameOf:(id:string)=>string;report:(error:unknown)=>void;enabled?:boolean;embedded?:boolean;
}) {
  const key=[base,snapshotId,revision,draftRevision].join(':');
  const [state,setState]=useState<{key:string;data:Page}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[retry,setRetry]=useState(0);
  const reading=useRef<AbortController|null>(null), successfulRetry=useRef(-1);
  const data=state?.key===key?state.data:null;
  async function load(offset:number,signal:AbortSignal) {
    setBusy(true);setError('');
    try {
      const query=new URLSearchParams({expectedRevision:String(revision),expectedDraftRevision:String(draftRevision),offset:String(offset)});
      const page=await api(base+'/snapshots/'+snapshotId+'/changes?'+query,inputChangesResponse,undefined,signal);
      if(signal.aborted)return;
      if(page.currentRevision!==revision||page.currentDraftRevision!==draftRevision||page.offset!==offset)throw new ApiError('VERSION_CONFLICT',409);
      successfulRetry.current=retry;
      setState(old=>({key,data:{...page,changes:offset&&old?.key===key?[...old.data.changes,...page.changes]:page.changes}}));
    } catch(e) {
      if(signal.aborted)return;
      // Clear an incomplete older comparison on conflict; do not mix pages.
      setState(null);setError('差分を確認できませんでした。入力・固定の最新状態を読み直して再確認してください。');report(e);
    } finally {if(!signal.aborted)setBusy(false);}
  }
  useEffect(()=>{
    if(!enabled)return;
    if(data && successfulRetry.current===retry){setBusy(false);return;}
    const controller=new AbortController();reading.current=controller;
    void load(0,controller.signal);
    return ()=>{controller.abort();reading.current?.abort();};
  },[key,retry,enabled]);
  return <Card className="input-changes panel" aria-label="計算時からの変更">
    {!embedded && <h3>計算時からの変更</h3>}
    <p className="muted">計算に使う条件と参照版の比較です。差分の確認後も、現在条件での計算・独立検証が必要です。</p>
    {error&&<p role="alert" className="warning">{error}</p>}
    {data&&<>
      <p>入力版{data.inputRevision} → 現在の版{data.currentRevision} ／ 固定・編集版{data.sourceDraftRevision} → {data.currentDraftRevision}</p>
      {data.currentInputStatus==='UNAVAILABLE'&&<p className="warning">現在の条件を計算用に組み立てられません。登録した入力の差分を表示しています。設定を見直してから再計算してください。</p>}
      <p>合計{data.total}件の変更（{data.changes.length}件を表示）</p>
      {(['input', 'publication'] as const).map(category => {
        const title = category === 'input' ? '入力条件の変更' : '公開版・公開勤務の変化';
        const rows = data.changes.filter(row => inputChangeCategory(row) === category);
        return <section key={category} aria-label={title} className="change-category">
        <h4>{title}</h4><p>{data.totals[category]}件の変更（{rows.length}件を表示）</p>
        {data.totals[category] === 0 ? <p>変更はありません。</p> : rows.length === 0 ? <p>「次の50件を確認」で続きを取得してください。</p> :
        <div className="table-scroll" tabIndex={0} role="region" aria-label={`${title}の比較表`}>
          <Table className="input-changes-table"><thead><tr><TableHead scope="col">変更項目</TableHead><TableHead scope="col">計算時</TableHead><TableHead scope="col">現在</TableHead></tr></thead>
            <tbody>{rows.map((row,i)=><tr key={i}><TableHead scope="row">{changeLabel(row.path,nameOf,row.entityName)}</TableHead>
              <TableCell>{changeValue(row.before,row.path,row.beforeTruncated)}</TableCell><TableCell>{changeValue(row.after,row.path,row.afterTruncated)}</TableCell></tr>)}</tbody>
          </Table>
        </div>}
        </section>;
      })}
    </>}
    <div className="form-actions">
      {data&&data.nextOffset!==null&&<Button disabled={busy} onClick={()=>{const controller=new AbortController();reading.current?.abort();reading.current=controller;void load(data.nextOffset!,controller.signal);}}>次の50件を確認</Button>}
      {busy&&<Loading label="差分を確認しています…" compact={!!data} />}
      {!busy&&<Button onClick={()=>setRetry(n=>n+1)}>差分を読み直す</Button>}
    </div>
  </Card>;
}
