import { SectionSettingsForm, SettingsSection } from "./section-settings";
import { SettingHeading, Alert, Button, Card, CardContent, Input, TimeInput, Loading, NativeSelect, OperationBoundary, useNotification } from "./components/ui";
import { UnsavedForm, useUnsavedInput, usePendingOperation } from "./unsaved-input";
import React,{useEffect,useRef,useState} from 'react';
import { z } from 'zod';
import { api,ApiError } from './api';
import { Field } from './contract-forms';
import { submissionContext,submissionWindowContext,submissionReceipt,staffSubmission,submissionWindowCommand } from '../../api/src/staff-submission-contract';
import { submissionDraft,submissionPayload,jstWindowTime,type UnavailableRow,type PreferenceRow } from './submission-model';
import { clock } from './planning-model';

type Pending={kind:'self';body:z.infer<typeof staffSubmission>;saved?:()=>void}|{kind:'window';body:z.infer<typeof submissionWindowCommand>};
const jst=(n:number)=>new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(n);
export function StaffSubmission({base,month,manager,self,report,changed}:{base:string;month:string;manager:boolean;self:boolean;report:(e:unknown)=>void;changed:()=>Promise<unknown>}) {
  const [data,setData]=useState<z.infer<typeof submissionContext>|null>(null),[window,setWindow]=useState<z.infer<typeof submissionWindowContext>|null>(null);
  const [unavailable,setUnavailable]=useState<UnavailableRow[]>([]),[preferences,setPreferences]=useState<PreferenceRow[]>([]);
  const [busy,setBusy]=useState(true),[pending,setPending]=useState<Pending|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[endDate,setEndDate]=useState(''),[endTime,setEndTime]=useState('');
  useNotification(notice);
  useNotification(error, "error");
  const unsaved=useUnsavedInput();
  usePendingOperation(busy||pending!==null);
  const [resetKey,setResetKey]=useState(0);
  const lifetime=useRef<AbortController|null>(null),generation=useRef(0);
  const ownPath=base+'/self-month/'+month,windowPath=base+'/submission-window/'+month;
  async function load(signal?:AbortSignal, keepDrafts = false) {
    const current=generation.current;
    const [own,window]=await Promise.all([self?api(ownPath,submissionContext,undefined,signal):null,manager?api(windowPath,submissionWindowContext,undefined,signal):null]);
    if(lifetime.current?.signal.aborted||current!==generation.current)return;
    setData(own);setWindow(window);
    if(own){const draft=submissionDraft(own.version?.payload??{unavailable:[],preferences:[]});if(!keepDrafts){setUnavailable(draft.unavailable);setPreferences(draft.preferences);setResetKey(key=>key+1);}}
  }
  useEffect(()=>{
    const controller=new AbortController();lifetime.current=controller;generation.current++;setBusy(true);
    load(controller.signal).catch(e=>{if(!controller.signal.aborted)fail(e);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>{controller.abort();generation.current++;};
  },[base,month,self,manager]);
  function fail(e:unknown) {
    setError(e instanceof Error?e.message:'処理できませんでした。');
    if(e instanceof ApiError&&['UNAUTHENTICATED','USER_DISABLED','PASSWORD_CHANGE_REQUIRED'].includes(e.code))report(e);
  }
  async function run(c:Pending) {
    if(busy)return;setBusy(true);setError('');setNotice('');setPending(c);
    try {
      const result=await api(c.kind==='self'?ownPath:windowPath,submissionReceipt,c.body,lifetime.current?.signal);
      if(lifetime.current?.signal.aborted)return;
      if(c.kind==='self') c.saved?.();
      else {setEndDate('');setEndTime('');}
      setPending(null);setNotice(c.kind==='self'?'設定を保存しました。再計算で最新条件に反映されます。':c.body.closesAt===null?'追加の受付を終了しました。通常の提出期限より前なら引き続き提出できます。':'指定日時まで受付を再開しました。');
      await load(lifetime.current?.signal,true);
      if(c.kind==='self')await changed();
      // The acknowledgment is meaningful even if a later context reload fails.
      void result;
    }catch(e){
      if(lifetime.current?.signal.aborted)return;
      if(!(e instanceof ApiError)||(e.status!==0&&e.status<500))setPending(null);
      fail(e);
    }finally{if(!lifetime.current?.signal.aborted)setBusy(false);}
  }
  const locked=busy||pending!==null,editable=data?.accepting===true&&!locked;
  const dayMax=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate();
  const dateInput=(value:string,onChange:(v:string)=>void)=><Input type="date" required min={month+'-01'} max={month+'-'+String(dayMax).padStart(2,'0')} value={value} onChange={e=>onChange(e.target.value)}/>;
  const timeInput=(value:string,onChange:(v:string)=>void,stepMinutes=1)=><TimeInput required value={value} stepMinutes={stepMinutes} onValueChange={onChange}/>;
  const fresh=()=>({key:crypto.randomUUID(),date:month+'-01',start:'',end:''});
  const updateUnavailable=(i:number,patch:Partial<UnavailableRow>)=>setUnavailable(rows=>rows.map((r,n)=>n===i?{...r,...patch}:r));
  const updatePreference=(i:number,patch:Partial<PreferenceRow>)=>setPreferences(rows=>rows.map((r,n)=>n===i?{...r,...patch}:r));
  return <OperationBoundary busy={busy}>{<>
    {busy && !data && !window && <Loading label="勤務不可・希望の条件を読み込んでいます…" />}
    {error&&<p role="alert" className="alert error">{error}</p>}

    {pending&&<Alert className="alert warning">応答が不明な場合は、同じ操作を再確認してください。入力の変更は確認後に行えます。<Button disabled={busy} onClick={()=>void run(pending)}>同じ操作を再確認</Button></Alert>}
    <div className="actions"><Button disabled={locked} onClick={async ()=>{if(!await unsaved.allow())return;setBusy(true);setError('');void load(lifetime.current?.signal).catch(fail).finally(()=>setBusy(false));}}>編集を破棄して最新を読み直す</Button></div>
    {self&&data&&<Card className="panel"><SettingHeading title="自分の勤務不可・希望" level={2} /><CardContent className="panel-body">
      <p className="form-intro">通常の提出期限：{data.deadline.deadlineDate} 23:59（日本時間）。勤務不可と希望に同じ期限を適用します。</p>
      {data.window?.closesAt!==null&&data.window?.closesAt!==undefined&&<p>管理者による追加受付：{jst(data.window.closesAt)}まで（日本時間）。</p>}
      <p role="status" className={data.accepting?'notice':'error'}>{data.accepting?'受付中':'受付終了。変更には管理者による受付再開が必要です。'}</p>
      <p className="muted">希望はすべて同じ強さで扱い、勤務希望とパターン希望はそれぞれ1件として評価します。公開済み勤務に関する休暇・欠勤は「休暇・欠勤」から申請してください。</p>
      <SectionSettingsForm key={resetKey} initial={data.version?.payload ?? {unavailable:[],preferences:[]}} disabled={!editable}
        allLabel="すべての勤務不可・希望を保存"
        fingerprints={{unavailable:JSON.stringify(unavailable),preferences:JSON.stringify(preferences)}}
        build={(_,scope,saved)=>{
          const stored=submissionDraft(saved??{unavailable:[],preferences:[]});
          return submissionPayload(month,scope==='all'||scope==='unavailable'?unavailable:stored.unavailable,scope==='all'||scope==='preferences'?preferences:stored.preferences);
        }}
        save={async(payload,saved)=>{await run({kind:'self',body:{operationId:crypto.randomUUID(),expectedRevision:data.revision,payload},saved});}}>
        <SettingsSection scope="unavailable" title="勤務不可日時" actions={<Button type="button" onClick={()=>setUnavailable(rows=>[...rows,fresh()])}>勤務不可を追加</Button>}><p className="muted">必須条件として扱います。時刻は数字4桁のHHMM（例：0930）で、分単位で入力してください。全日は0000〜2400です。</p>
        {unavailable.length===0&&<p className="muted">勤務不可日時の登録はありません。</p>}
        {unavailable.map((r,i)=><div className="setup-row" key={r.key}><h4>勤務不可 {i+1}</h4><div className="form-grid">
          <Field title="日付">{dateInput(r.date,v=>updateUnavailable(i,{date:v}))}</Field>
          <Field title="開始（HHMM）">{timeInput(r.start,v=>updateUnavailable(i,{start:v}))}</Field>
          <Field title="終了（HHMM、2400可）">{timeInput(r.end,v=>updateUnavailable(i,{end:v}))}</Field>
        </div><Button type="button" onClick={()=>setUnavailable(rows=>rows.filter((_,n)=>n!==i))}>勤務不可 {i+1}を削除</Button></div>)}

        </SettingsSection><SettingsSection scope="preferences" title="勤務の希望" actions={<Button type="button" onClick={()=>setPreferences(rows=>[...rows,{...fresh(),kind:'work',patternId:''}])}>希望を追加</Button>}>{preferences.length===0&&<p className="muted">希望の登録はありません。</p>}
        {preferences.map((r,i)=><div className="setup-row" key={r.key}><h4>希望 {i+1}</h4><div className="form-grid">
          <Field title="日付">{dateInput(r.date,v=>updatePreference(i,{date:v}))}</Field>
          <Field title="希望の種類"><NativeSelect value={r.kind} onChange={e=>updatePreference(i,{kind:e.target.value as PreferenceRow['kind']})}><option value="work">勤務を希望</option><option value="off">休日を希望</option><option value="pattern">勤務パターンを希望</option><option value="window">出退勤の時間帯を希望</option></NativeSelect></Field>
          {r.kind==='pattern'&&<Field title="勤務パターン"><NativeSelect required value={r.patternId} onChange={e=>updatePreference(i,{patternId:e.target.value})}><option value="">選択してください</option>{data.patterns.map(p=><option key={p.id} value={p.id}>{p.id}（{clock(p.start)}〜{clock(p.end)}）</option>)}</NativeSelect></Field>}
          {r.kind==='window'&&<><Field title="希望時間帯の開始（30分単位）">{timeInput(r.start,v=>updatePreference(i,{start:v}),30)}</Field><Field title="希望時間帯の終了（30分単位）">{timeInput(r.end,v=>updatePreference(i,{end:v}),30)}</Field></>}
        </div><Button type="button" onClick={()=>setPreferences(rows=>rows.filter((_,n)=>n!==i))}>希望 {i+1}を削除</Button></div>)}

        </SettingsSection>
      </SectionSettingsForm>
    </CardContent></Card>}
    {manager&&window&&<Card className="panel"><SettingHeading title="このチームの受付再開" level={2} /><CardContent className="panel-body">
      <p className="form-intro">通常の提出期限：{window.deadline.deadlineDate} 23:59（日本時間）。勤務不可・希望の両方を追加で受け付けます。</p>
      <p>追加受付の終了日時：{window.window?.closesAt?jst(window.window.closesAt)+'（日本時間）':'設定なし'}</p>
      <UnsavedForm preserveOtherInputs dirty={endDate!==''||endTime!==''} onSubmit={e=>{e.preventDefault();try{void run({kind:'window',body:{operationId:crypto.randomUUID(),expectedRevision:window.window?.revision??0,closesAt:jstWindowTime(endDate+'T'+endTime.slice(0,2)+':'+endTime.slice(2))}});}catch(e){fail(e);}}}><fieldset disabled={locked}>
        <div className="form-grid"><Field title="追加受付の終了日（日本時間）"><Input type="date" required value={endDate} onChange={e=>setEndDate(e.target.value)}/></Field><Field title="追加受付の終了時刻（HHMM・日本時間）"><TimeInput required value={endTime} allowEndOfDay={false} onValueChange={setEndTime}/></Field></div>
        <div className="form-actions"><Button className="primary" type="submit">この日時まで受付を再開</Button><Button type="button" onClick={async ()=>{if(await unsaved.allow())void run({kind:'window',body:{operationId:crypto.randomUUID(),expectedRevision:window.window?.revision??0,closesAt:null}});}}>追加受付を終了</Button></div>
      </fieldset></UnsavedForm>
    </CardContent></Card>}
  </>}</OperationBoundary>;
}
