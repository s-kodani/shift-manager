import { Button, Card, CardHeader, CardContent, Loading, OperationBoundary } from "./components/ui";
import { RefreshCw } from 'lucide-react';
import React,{useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {api} from './api';
import {publicationHistoryPage,publicationNoticePage} from '../../api/src/publication-browse-contract';

const stamp=(time:number)=>new Date(time).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'});
export function PublicationHistory({base,month,selectedId,onSelect,report}:{base:string;month:string;selectedId:string|null;onSelect:(id:string)=>void;report:(e:unknown)=>void}){
  const [page,setPage]=useState<z.infer<typeof publicationHistoryPage>|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  const life=useRef<AbortController|null>(null),lock=useRef(false);
  useEffect(()=>{const c=new AbortController();life.current=c;setPage(null);setError('');lock.current=false;setBusy(false);
    api(base+'/history?month='+month,publicationHistoryPage,undefined,c.signal).then(p=>{if(!c.signal.aborted)setPage(p);}).catch(e=>{if(!c.signal.aborted){setError('公開履歴を取得できませんでした。');report(e);}});return()=>c.abort();
  },[base,month,retry]);
  async function more(){
    if(!page?.nextCursor||lock.current)return;const signal=life.current!.signal;lock.current=true;setBusy(true);setError('');
    try{const p=await api(base+`/history?month=${month}&cursorRevision=${page.nextCursor.revision}`,publicationHistoryPage,undefined,signal);
      if(!signal.aborted)setPage(old=>old?{versions:[...old.versions,...p.versions.filter(v=>!old.versions.some(x=>x.publicationId===v.publicationId))],nextCursor:p.nextCursor}:p);
    }catch(e){if(!signal.aborted){setError('続きの公開履歴を取得できませんでした。同じページから再確認できます。');report(e);}}
    finally{if(!signal.aborted){lock.current=false;setBusy(false);}}
  }
  return <details><summary>公開履歴{page?`（取得済み${page.versions.length}版）`:''}</summary>
    {error&&<p role="alert" className="warning">{error}</p>}
    {!page&&!error&&<Loading label="公開履歴を取得しています…" />}
    {error && !page && <Button onClick={() => setRetry(n => n + 1)}>公開履歴を再読込</Button>}
    {page?.versions.length===0&&<p>公開履歴はありません。</p>}
    {page?.versions.map(v=><article className="setup-row" key={v.publicationId}>
      <strong>公開版{v.publicationRevision}・入力版{v.inputRevision}</strong>
      <p>{stamp(v.recordedAt)}（日本時間）</p><p>公開者：{v.actorName}（現在の表示名）</p>
      <p>公開元：{v.sourceKind==='cancellation'?'休暇・欠勤による勤務取消':v.sourceKind==='job'?'計算した案':'保存済み編集案'}</p>
      <Button disabled={busy||selectedId===v.publicationId} onClick={()=>onSelect(v.publicationId)}>公開版{v.publicationRevision}を表示</Button>
      <details><summary>記録の参照</summary><p className="muted">公開ID：{v.publicationId}</p><p className="muted">公開者ID：{v.actorId}</p><p className="muted">公開元ID：{v.sourceId}</p></details>
    </article>)}
    {page?.nextCursor&&<div className="form-actions"><Button loading={busy} disabled={busy} onClick={()=>void more()}>{busy?'公開履歴を取得しています…':'以前の公開履歴を取得'}</Button></div>}
  </details>;
}

export function PublicationNotices({base,onOpen,disabled,report}:{base:string;onOpen:(month:string,id:string)=>void;disabled:boolean;report:(e:unknown)=>void}){
  const [page,setPage]=useState<z.infer<typeof publicationNoticePage>|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true);
  const life=useRef<AbortController|null>(null),lock=useRef(false);
  useEffect(()=>{const c=new AbortController();life.current=c;lock.current=false;setBusy(false);setError('');setLoading(true);
    api(base+'/notices',publicationNoticePage,undefined,c.signal).then(p=>{if(!c.signal.aborted)setPage(p);}).catch(e=>{if(!c.signal.aborted){setError('お知らせを取得できませんでした。');report(e);}}).finally(()=>{if(!c.signal.aborted)setLoading(false);});return()=>c.abort();
  },[base,refresh]);
  async function run(id?:string){
    if(lock.current||!page)return;const signal=life.current!.signal;lock.current=true;setBusy(true);setError('');
    try{
      if(id){const r=await api(base+`/notices/${id}/read`,z.object({publicationId:z.string().uuid(),read:z.literal(true),readAt:z.number().int().nonnegative().safe()}),{},signal);if(r.publicationId!==id)throw new Error('既読の参照先が一致しません。');
        if(!signal.aborted)setPage(old=>old?{...old,notices:old.notices.map(n=>n.publicationId===id?{...n,readAt:r.readAt}:n)}:old);
      }else if(page.nextCursor){const c=page.nextCursor,p=await api(base+`/notices?cursorTime=${c.recordedAt}&cursorId=${encodeURIComponent(c.id)}`,publicationNoticePage,undefined,signal);
        if(!signal.aborted)setPage(old=>old?{notices:[...old.notices,...p.notices.filter(n=>!old.notices.some(x=>x.publicationId===n.publicationId))],nextCursor:p.nextCursor}:p);
      }
    }catch(e){if(!signal.aborted){setError('お知らせの操作を確認できませんでした。同じ操作で再確認できます。');report(e);}}
    finally{if(!signal.aborted){lock.current=false;setBusy(false);}}
  }
  return <OperationBoundary busy={busy}><Card className="panel"><CardHeader className="notice-heading" aria-busy={loading || undefined}><h2>自分へのシフトのお知らせ</h2>
    <Button size="icon" aria-label="最新のお知らせを読み直す" title="最新のお知らせを読み直す" disabled={busy||loading} onClick={()=>{setLoading(true);setRefresh(r=>r+1);}}><RefreshCw aria-hidden="true" className={loading ? 'animate-spin motion-reduce:animate-none' : undefined} /></Button>
  </CardHeader><CardContent className="panel-body">
    {error&&<p role="alert" className="warning">{error}</p>}
    {page&&loading&&<Loading label="お知らせを更新しています…" compact />}
    {!page&&!error&&<Loading label="お知らせを取得しています…" />}
    {page?.notices.length===0&&<p>お知らせはありません。</p>}
    {page?.notices.map(n=><article className="setup-row" key={n.publicationId}><strong>{n.month}のシフトが公開されました</strong>
      <p>{stamp(n.recordedAt)}（日本時間）</p>
      <div className="form-actions"><Button disabled={busy||disabled} onClick={()=>onOpen(n.month,n.publicationId)}>対象の公開版を見る</Button>
      {n.readAt!==null?<span className="muted">既読</span>:<Button disabled={busy} onClick={()=>void run(n.publicationId)}>既読にする</Button>}</div>
    </article>)}
    {page?.nextCursor&&<div className="form-actions"><Button loading={busy} disabled={busy} onClick={()=>void run()}>{busy?'お知らせを取得しています…':'以前のお知らせを取得'}</Button></div>}
  </CardContent></Card></OperationBoundary>;
}
