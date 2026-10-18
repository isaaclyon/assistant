import { lstat, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

/** First legacy-to-native activation cannot infer admission from legacy payloads.
 * Read the current WAL snapshot, then repeat after all writers stop. Native-to-
 * native upgrades retain the native host's source-binding recovery protocol. */
export async function assertLegacyInboxDrained(path:string,uid:number):Promise<void> {
 const refuse=()=>new Error('Legacy inbox is not proven empty; drain or preserve and quarantine it before native activation');
 try {
  const metadata=await lstat(path).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!metadata){
   for(const suffix of ['-wal','-journal','-shm'])if(await lstat(`${path}${suffix}`).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw refuse();
   return;
  }
  if(!metadata.isFile()||metadata.nlink!==1||metadata.uid!==uid||(metadata.mode&0o022)!==0||await realpath(path)!==path)throw refuse();
  const db=new DatabaseSync(path,{readOnly:true});
  try {
   db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN');
   const objects=db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
   if(objects.length!==1||objects[0]!.type!=='table'||objects[0]!.name!=='pending_turn')throw refuse();
   const columns=db.prepare('PRAGMA table_info(pending_turn)').all().map(c=>`${c.name}:${c.type}:${c.pk}`).join(',');
   if(columns!=='id:TEXT:1,payload:TEXT:0,enqueued_at:INTEGER:0')throw refuse();
   if(db.prepare('SELECT 1 AS present FROM pending_turn LIMIT 1').get())throw refuse();
  } finally {db.close();}
 } catch {throw refuse();}
}
