import { Button, Loading, OperationBoundary } from "./components/ui";
import React,{useEffect,useRef,useState,type ReactNode} from 'react';
import { z } from 'zod';
import { api,ApiError } from './api';
import { explanationResponse,type ExplanationResponse,explanationCommand,explanationSource } from '../../api/src/explanation-contract';

const reasons:Record<string,string>={AI_DISABLED:'現在AI説明は利用できません。確認済みの集計を表示しています。',STALE_SOURCE:'入力や固定が変更されています。当時の根拠を表示しています。',INSUFFICIENT_GROUNDS:'説明に必要な数値を照合できていません。確認できた状態を表示しています。',OUTPUT_MISMATCH:'AI説明の根拠を照合できなかったため、定型表示へ切り替えました。',TIMEOUT:'AI説明の時間内に完了を確認できなかったため、定型表示へ切り替えました。',PROVIDER_ERROR:'AI説明を取得できなかったため、定型表示へ切り替えました。',EXPLANATION_BUSY:'同じチームの説明を生成中です。しばらくして再確認してください。',EXPLANATION_LIMIT:'本日の説明生成の上限に達しました。確認済みの集計は引き続き利用できます。',EXPLANATION_STALE:'入力が変更されました。最新の案をご確認ください。'};
export function ExplanationView({company,team,source,Panel}:{company:string;team:string;source:z.infer<typeof explanationSource>;Panel:(props:{title:string;children:ReactNode})=>ReactNode}){
  const base=`/companies/${company}/explanations/teams/${team}`;
  const [data,setData]=useState<ExplanationResponse|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const command=useRef<z.infer<typeof explanationCommand>|null>(null),life=useRef<AbortController|null>(null),details=useRef<HTMLDetailsElement|null>(null);
  const accept=(response:ExplanationResponse)=>{
    if(response.grounds.source.kind!==source.kind||response.grounds.source.id!==source.id)throw new Error('説明の参照先が一致しません。');
    setData(response);
  };
  useEffect(()=>{
    const c=new AbortController();life.current=c;setData(null);setError('');
    api(base+`?kind=${source.kind}&id=${source.id}`,explanationResponse,undefined,c.signal).then(r=>{if(!c.signal.aborted)accept(r);}).catch(e=>{if(!c.signal.aborted)setError(e instanceof Error?e.message:'説明を取得できませんでした。');});
    return ()=>c.abort();
  },[base,source.kind,source.id]);
  async function generate(){
    if(!data||busy)return;setBusy(true);setError('');
    const c=command.current??{operationId:crypto.randomUUID(),source,digest:data.grounds.digest};command.current=c;
    try{const r=await api(base,explanationResponse,c,life.current?.signal);if(life.current?.signal.aborted)return;accept(r);if(r.mode!=='pending')command.current=null;}
    catch(e){
      if(life.current?.signal.aborted)return;
      if(!(e instanceof ApiError)||e.status!==0&&e.status<500)command.current=null;
      if(e instanceof ApiError&&e.code==='EXPLANATION_SOURCE_CONFLICT'){
        try{const current=await api(base+`?kind=${source.kind}&id=${source.id}`,explanationResponse,undefined,life.current?.signal);if(life.current?.signal.aborted)return;accept(current);setError('説明の根拠を読み直しました。内容を確認してから、必要ならもう一度要約してください。');}
        catch(reload){if(!life.current?.signal.aborted)setError(reload instanceof Error?reload.message:'根拠を読み直せませんでした。');}
      }else setError(e instanceof Error?e.message:'説明を取得できませんでした。');
    }
    finally{if(!life.current?.signal.aborted)setBusy(false);}
  }
  return <OperationBoundary busy={busy}>{<Panel title="配置結果の説明">
    <p>この月の案について、検証済みの根拠と短い要約を表示します。原因や改善量が未確認の場合は断定しません。</p>
    {error&&<p className="warning" role="alert">{error} シフトの確認・編集は続けられます。</p>}
    {data&&<>
      <p className="muted">対象 {data.grounds.month}・入力版{data.grounds.inputRevision}・{source.kind==='draft'?'保存済み編集案':'計算した案'}</p>
      {data.grounds.stale&&<p className="warning">当時の説明です。現在の条件や固定に対応する最新の案をご確認ください。</p>}
      <div className="setup-row" role="status">
        <strong>{data.mode==='ai'?'AI要約（根拠照合済み）':data.mode==='pending'?'AI説明を生成中・確認済みの集計':'確認済みの集計'}</strong>
        {data.summary.split('\n').map((line,i)=><p key={i}>{line} {data.factIds[i]&&<a href={`#explanation-${data.factIds[i]}`} onClick={()=>{if(details.current)details.current.open=true;}}>根拠</a>}</p>)}
        {data.reason&&<p className="muted">{reasons[data.reason]??'確認済みの集計を表示しています。'}</p>}
      </div>
      <Button loading={busy} disabled={busy||data.grounds.stale||!data.grounds.metricsAvailable||data.reason==='AI_DISABLED'} onClick={()=>void generate()}>{busy?'説明を取得しています…':command.current?'同じ操作を再確認':data.mode==='ai'?'保存済みのAI説明を確認':'AIで短く要約する'}</Button>
      {data.generatedAt!==null&&<p className="muted">生成 {new Date(data.generatedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}（日本時間）</p>}
      <details ref={details}><summary>根拠と確認する条件</summary>
        <p className="muted">{[...data.grounds.taskAliases,...data.grounds.roleAliases].map(t=>`${t.alias}：${t.id}`).join(' ／ ')}</p>
        {data.grounds.facts.map(f=><div className="setup-row" key={f.id} id={`explanation-${f.id}`}><p>{f.text}</p></div>)}
        {data.grounds.omittedFacts>0&&<p>ほかに{data.grounds.omittedFacts}件の詳細があります。不足と検証結果の一覧をご確認ください。</p>}
      </details>
      <p className="muted">説明から条件・配置・承認・公開を自動変更することはありません。</p>
    </>}
    {!data&&!error&&<Loading label="検証の根拠を取得しています…" />}
  </Panel>}</OperationBoundary>;
}
