// Keep the first matching row, like the previous Array.find lookup. Index by
// both fields separately so identifiers cannot collide with a date separator.
export function indexMonthlyAssignments<T extends {staffId:string;date:string}>(rows:readonly T[] | null) {
 const people=new Map<string,Map<string,T>>();
 for(const row of rows??[]) {
  let days=people.get(row.staffId);
  if(!days){days=new Map();people.set(row.staffId,days);}
  if(!days.has(row.date))days.set(row.date,row);
 }
 return people;
}

export function indexStaffNames(rows:readonly {id:string;name:string}[]) {
 const names=new Map<string,string>();
 for(const row of rows)if(!names.has(row.id))names.set(row.id,row.name);
 return names;
}
