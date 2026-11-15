import { admitMaintenance, releaseMaintenance, MaintenanceError } from './maintenance';

export async function withMaintenanceDatabase<T>(db:D1Database,work:(guarded:D1Database)=>Promise<T>):Promise<T>{
  const lease=await admitMaintenance(db,'FOREGROUND',1);
  if(!lease)throw new MaintenanceError();
  const guarded=maintenanceDatabase(db,lease);
  try{
    const result=await work(guarded);
    // Auth libraries can turn a database error into their own HTTP response.
    // Do not return it as a completed request after its authority was retired.
    await guarded.prepare('SELECT 1 AS admitted').first();
    return result;
  }finally{await releaseMaintenance(db,lease);}
}

export function databaseOnlyAuthPath(path:string){
  return ['/api/auth/sign-in/email','/api/auth/sign-out','/api/auth/get-session',
    '/api/auth/reset-password','/api/password','/api/access'].includes(path);
}

// The lease check and every SQL statement share one D1 transaction. A retired
// request cannot pass a separate read check and then write after retirement.
// Auth uses resourceGuard=0; business uses 1 with separately guarded resource
// adapters. SQL retirement alone is not proof of physical Container termination
// or completion of arbitrary mail/provider requests.
export function maintenanceDatabase(db:D1Database,leaseId:string,resourceGuard:0|1=0):D1Database {
  return scopedDatabase(db,leaseId,"kind='FOREGROUND' AND guard_version=1 AND resource_guard="+resourceGuard+" AND delivery_guard=0");
}
export function maintenanceDeliveryDatabase(db:D1Database,leaseId:string):D1Database {
  return scopedDatabase(db,leaseId,"kind='BACKGROUND' AND guard_version=0 AND resource_guard=0 AND delivery_guard=1");
}
function scopedDatabase(db:D1Database,leaseId:string,scope:string):D1Database {
  const originals=new WeakMap<D1PreparedStatement,D1PreparedStatement>();
  async function batch<T>(statements:D1PreparedStatement[]):Promise<D1Result<T>[]> {
    if(!statements.length)return [];
    const raw=statements.map(s=>{
      const original=originals.get(s);
      if(!original)throw new MaintenanceError('MAINTENANCE_STATEMENT_SCOPE');
      return original;
    });
    try {
      const rows=await db.batch<T>([
        // SQLite abs(INT64_MIN) raises on the false branch. A zero-row
        // conditional UPDATE would not enforce this transaction boundary.
        db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM maintenance_lease
          WHERE id=? AND ${scope} AND completed_at IS NULL)
          THEN 1 ELSE abs(-9223372036854775808) END AS admitted`).bind(leaseId),
        ...raw,
      ]);
      return rows.slice(1);
    }catch(error){
      const active=await db.prepare(`SELECT 1 FROM maintenance_lease WHERE id=? AND ${scope} AND completed_at IS NULL`).bind(leaseId).first();
      if(!active)throw new MaintenanceError('MAINTENANCE_LEASE_RETIRED');
      throw error;
    }
  }
  function wrap(original:D1PreparedStatement):D1PreparedStatement {
    const statement=new Proxy(original,{get(target,key){
      if(key==='bind')return (...values:unknown[])=>wrap(target.bind(...values));
      if(key==='run'||key==='all')return async<T>()=>(await batch<T>([statement]))[0];
      if(key==='first')return async(column?:string)=>{
        const row=(await batch<Record<string,unknown>>([statement]))[0].results[0]??null;
        if(column===undefined||row===null)return row;
        if(!(column in row))throw new Error('D1_COLUMN_NOTFOUND');
        return row[column];
      };
      // Do not expose a raw execution escape hatch or approximate raw column
      // metadata. The pinned Better Auth adapter uses all/run/batch only.
      throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_DATABASE_METHOD');
    }});
    originals.set(statement,original);return statement;
  }
  return new Proxy(db,{get(target,key){
    if(key==='prepare')return (sql:string)=>wrap(target.prepare(sql));
    if(key==='batch')return batch;
    // Session, exec, dump and unknown future methods must not bypass the guard.
    throw new MaintenanceError('MAINTENANCE_UNSUPPORTED_DATABASE_METHOD');
  }});
}
