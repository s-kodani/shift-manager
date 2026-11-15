import { Button, Table, TableCell, TableHead } from "./components/ui";
import {useMemo} from 'react';
import type {OptimizerAssignments} from '../../../packages/contracts/optimizer-input.generated';
import {indexMonthlyAssignments} from './monthly-index';

const time=(minutes:number)=>`${String(Math.floor(minutes/60)).padStart(2,'0')}:${String(minutes%60).padStart(2,'0')}`;
export function MonthlyTable({month,staff,assignments,nameOf,choose,onCell,onStaff}:{
 month:string;staff:readonly {id:string}[];assignments:OptimizerAssignments|null;
 nameOf:(id:string)=>string;choose:(date:string)=>void;onCell:(staffId:string,date:string)=>void;onStaff?:(id:string)=>void;
}) {
 const people=useMemo(()=>indexMonthlyAssignments(assignments),[assignments]);
 const dates=useMemo(()=>Array.from({length:new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5)),0)).getUTCDate()},
  (_,i)=>month+'-'+String(i+1).padStart(2,'0')),[month]);
 if(assignments===null)return <p>この計算では勤務案を得られていません。</p>;
 return <div className="table-scroll"><Table className="month-table">
  <thead><tr><TableHead>スタッフ</TableHead>{dates.map((date,i)=><TableHead key={date} scope="col"><Button type="button" variant="ghost" className="month-date-button" aria-label={`${date} 日別業務配置`} onClick={()=>choose(date)}>{i+1}</Button></TableHead>)}</tr></thead>
  <tbody>{staff.map(person=>{const name=nameOf(person.id),days=people.get(person.id);
   return <tr key={person.id}><TableHead scope="row">{onStaff ? <Button type="button" variant="ghost" className="staff-name-button" data-staff-id={person.id} onClick={()=>onStaff(person.id)}>{name}</Button> : name}</TableHead>{dates.map(date=>{const assignment=days?.get(date);
    return <TableCell key={date}>{assignment ? <Button type="button" className={assignment.shift?'work-cell':'off-cell'} onClick={()=>onCell(person.id,date)}
     aria-label={`${name} ${date} 勤務詳細`}>
     {assignment.shift?<>{time(assignment.shift.start)}<br/>{time(assignment.shift.end)}</>:'休日'}
    </Button> : <span className="unconfirmed-cell">未確認</span>}</TableCell>;
   })}</tr>;
  })}</tbody>
 </Table></div>;
}
