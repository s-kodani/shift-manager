import type { InputChange } from '../../api/src/input-changes-contract';
const labels: Record<string,string> = {
  sources:'参照した設定版',calendar:'企業カレンダー',company_policy:'企業共通ルール',employment_policy:'雇用区分ルール',
  resources:'登録した入力',rule:'勤務ルール',deadlineDay:'希望・勤務不可の締切日',halfDayDivider:'半日の区切り',roleRounding:'担当区分人数の端数処理',
  team_config:'チーム設定',planning:'需要・予定',staff_contract:'スタッフ契約',staff_month:'勤務不可・希望',
  work_history:'確認済み履歴',published_history:'公開勤務の履歴',published_schedule:'公開勤務',
  planning_participation_removal:'予定の参加解除',published_fixed_release:'公開勤務の固定解除',
  manual_draft:'固定・編集案',
  staff:'スタッフ',contract:'勤務可能時間',rules:'勤務ルール',preferences:'希望',unavailable:'勤務不可',
  skills:'習熟度',roleIds:'対応可能な担当',level:'習熟度',capacity:'処理能力係数',
  dailyMax:'日上限（分）',weeklyMax:'週上限（分）',monthlyMax:'月上限（分）',monthlyMin:'月最低時間（分）',
  minDays:'月最低勤務日数',minOff:'月最低休日数',maxConsecutive:'最大連続勤務日数',weekdays:'曜日',
  start:'開始',end:'終了',date:'勤務日',kind:'種類',patternId:'勤務パターン',staffId:'スタッフ',staffIds:'参加者',
  demand:'必要人数',direct:'直接入力人数',calculated:'算出人数',events:'研修・会議',taskId:'業務',
  tasks:'業務設定',patterns:'勤務パターン',roles:'担当区分設定',roleRequirements:'必要担当区分',
  minimumLevel:'最低習熟度',minimumMinutes:'最低継続（分）',allowedTasks:'対象業務',
  transitions:'業務切替',fromTaskId:'切替元',toTaskId:'切替先',minutes:'準備・移動（分）',
  breakRule:'休憩ルール',basis:'計算基準',threshold:'休憩が必要になる時間（分）',requiredMinutes:'必要休憩（分）',
  afterStart:'勤務開始から取得可能になる時間（分）',beforeEnd:'勤務終了までに残す時間（分）',
  breakKind:'休憩の種類',fixedBreak:'固定休憩',break:'休憩',weekStart:'週の開始曜日',
  priority:'評価の優先順位',capacityScale:'処理能力係数の基準',slotMinutes:'業務枠（分）',
  mode:'計算対象',history:'過去の実績',workedMinutes:'実勤務（分）',published:'公開済み勤務',
  locks:'明示固定',exceptions:'勤務不可例外',shift:'勤務',parts:'固定対象',reason:'理由',lockId:'対象の固定',
  minimum:'最低人数',ratio:'必要比率',numerator:'分子',denominator:'分母',rounding:'端数処理',roleId:'担当区分',id:'識別名',
};
const values:Record<string,string>={work:'勤務希望',off:'休日希望',pattern:'勤務パターン',window:'希望時間帯',
  general:'一般業務',dedicated:'専任業務',training:'研修',meeting:'会議',worked:'実勤務時間',elapsed:'拘束時間',
  fixed:'固定',auto:'自動',coverage:'充足優先',preferences:'希望優先',first:'担当区分先行',same:'同段階',
  floor:'切り捨て',ceil:'切り上げ',draft:'公開前の計算',reallocation:'公開後の再配置',time:'出退勤',break:'休憩'};
const weekday=['月','火','水','木','金','土','日'];
export function changeLabel(path:string[],nameOf:(id:string)=>string,entityName?:string) {
  return path.map((part,i)=>{
    if(path[0]==='staff'&&i===1)return nameOf(part);
    if(['sources','resources'].includes(path[0])&&i===2) {
      if(path[1]==='staff_contract'||path[1]==='staff_month')return nameOf(part);
      if(path[1]==='employment_policy'&&entityName)return entityName;
      if(['company_policy','calendar','team_config','planning','published_schedule','employment_policy','manual_draft'].includes(path[1]))return '';
    }
    if(part==='0'&&path[i-1]==='fixedBreak')return '開始';
    if(part==='1'&&path[i-1]==='fixedBreak')return '終了';
    if(/^\d{4}-\d{2}-\d{2}/.test(part))return part.split(':').filter(Boolean).map(p=>{
      if(/^\d+$/.test(p)&&Number(p)<=1440)return `${String(Math.floor(Number(p)/60)).padStart(2,'0')}:${String(Number(p)%60).padStart(2,'0')}`;
      return values[p]??p;
    }).join('・');
    if(/^\d+$/.test(part))return `項目${Number(part)+1}`;
    return labels[part]??part.split(':').map(p=>values[p]??p).filter(Boolean).join('・');
  }).filter(Boolean).join(' ／ ');
}
export function changeValue(value:InputChange['before'],path:string[],truncated=false) {
  let text:string;
  if(value===undefined)text='未設定';
  else if(value===null)text='未入力';
  else if(typeof value==='boolean')text=value?'あり':'なし';
  else if(typeof value==='number'&&path[0]==='sources')text=`版${value}`;
  else if(typeof value==='number'&&(path.includes('weekdays')||path.at(-1)==='weekStart'))text=(path[0]==='resources'?['日','月','火','水','木','金','土']:weekday)[value]??String(value);
  else if(typeof value==='number'&&(['start','end'].includes(path.at(-1)??'')||path.includes('fixedBreak')||path.at(-2)==='break'))
    text=`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
  else text=typeof value==='string'?(values[value]??value):String(value);
  return text+(truncated?'…（長文のため先頭のみ）':'');
}
