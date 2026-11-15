// Fictional, bearer-protected probes only. Select the business transaction by
// its SQL, not its size: admission guards may add statements to the same batch.
export function interceptProbeBatch(
 db:D1Database,sqlPrefix:string,
 transform:(statements:D1PreparedStatement[])=>Promise<D1PreparedStatement[]>|D1PreparedStatement[],
):D1Database {
 const tracked=new WeakMap<D1PreparedStatement,{original:D1PreparedStatement;sql:string}>();
 function wrap(original:D1PreparedStatement,sql:string):D1PreparedStatement {
  const statement=new Proxy(original,{get(target,key){
   if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values),sql);
   const value=Reflect.get(target,key,target);
   return typeof value==='function'?value.bind(target):value;
  }});
  tracked.set(statement,{original,sql});return statement;
 }
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql),sql);
  if(key==='batch')return async<T>(statements:D1PreparedStatement[])=>{
   const selected=statements.some(s=>tracked.get(s)?.sql.trimStart().startsWith(sqlPrefix));
   const raw=statements.map(s=>tracked.get(s)?.original??s);
   return target.batch<T>(selected?await transform(raw):raw);
  };
  const value=Reflect.get(target,key,target);
  return typeof value==='function'?value.bind(target):value;
 }});
}
