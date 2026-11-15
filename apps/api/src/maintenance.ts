// Persist admission before starting any work. A stop and an admission cannot
// both win the same D1 serialization point. No request data lives in this table.
type Database = Pick<D1Database, 'prepare' | 'batch'>;
export class MaintenanceError extends Error {
  readonly status = 503;
  constructor(public code = 'MAINTENANCE_UNAVAILABLE') { super(code); }
}
export const maintenanceHeaders = {
  'cache-control': 'no-store', 'retry-after': '60',
};
export async function settledMaintenanceWork<T>(operations:Iterable<T|PromiseLike<T>>):Promise<T[]> {
  // Promise.all rejects early while sibling writes can still be running. Do
  // not let failure cleanup or a completion marker overtake those writes.
  const rows=await Promise.allSettled(operations),values:T[]=[];
  for(const row of rows){if(row.status==='rejected')throw row.reason;values.push(row.value);}
  return values;
}
export function maintenanceResponse() {
  return Response.json({error:'MAINTENANCE_UNAVAILABLE'}, {status:503, headers:maintenanceHeaders});
}
export async function requireRecoverySecurity(db:Database,restoreId:string){
  if(restoreId&&!await db.prepare('SELECT 1 FROM recovery_security_authorization WHERE restore_id=?').bind(restoreId).first())throw new MaintenanceError('RECOVERY_SECURITY_REQUIRED');
}
export async function admitMaintenance(db: Database, kind:'FOREGROUND'|'BACKGROUND',guardVersion:0|1=0,resourceGuard:0|1=0,deliveryGuard:0|1=0) {
  const id=crypto.randomUUID();
  let r:D1Result;
  try{r=await db.prepare(`INSERT INTO maintenance_lease(id,kind,started_at,guard_version,resource_guard,delivery_guard)
    SELECT ?,?,?,?,?,? FROM maintenance_state WHERE id=1 AND
    (mode='OPEN' OR (?='BACKGROUND' AND mode='DRAINING'))`)
    .bind(id,kind,Date.now(),guardVersion,resourceGuard,deliveryGuard,kind).run();}catch{throw new MaintenanceError();}
  return r.meta.changes===1?id:null;
}
export async function releaseMaintenance(db:Database,id:string) {
  // Called only after the owned work settles. A failed deletion must leave
  // positive completion evidence; interruption before this write stays unknown.
  await db.prepare('UPDATE maintenance_lease SET completed_at=COALESCE(completed_at,?) WHERE id=?')
    .bind(Date.now(),id).run();
  const r=await db.prepare('DELETE FROM maintenance_lease WHERE id=? AND completed_at IS NOT NULL').bind(id).run();
  if(r.meta.changes!==1){
    // A concurrent operator can reclaim this same completed lease. Its durable
    // audit is the only acceptable explanation for a zero-row owned release.
    const recovered=await db.prepare(`SELECT r.lease_id FROM maintenance_lease_recovery r JOIN maintenance_recovery_commit c ON c.operation_id=r.operation_id WHERE r.lease_id=?
      UNION ALL SELECT r.lease_id FROM maintenance_lease_retirement r JOIN maintenance_retirement_commit c ON c.operation_id=r.operation_id WHERE r.lease_id=?
      UNION ALL SELECT r.lease_id FROM maintenance_delivery_lease_retirement r JOIN maintenance_retirement_commit c ON c.operation_id=r.operation_id WHERE r.lease_id=?`).bind(id,id,id).first();
    if(!recovered)throw new MaintenanceError('MAINTENANCE_LEASE_LOST');
  }
}
export async function withMaintenance<T>(db:Database,kind:'FOREGROUND'|'BACKGROUND',work:()=>Promise<T>):Promise<T> {
  const id=await admitMaintenance(db,kind);
  if(!id)throw new MaintenanceError();
  try{return await work();}finally{await releaseMaintenance(db,id);}
}
