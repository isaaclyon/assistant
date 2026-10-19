import { afterEach, expect, test } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { assertLegacyInboxDrained } from '../../src/durable/deployment-inbox.js';
import { applyIsolatedMigration } from '../../src/isolated-migration.js';
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function fixture(){const dir=await realpath(await mkdtemp(join(tmpdir(),'deployment-inbox-')));directories.push(dir);return join(dir,'inbox.db');}
function create(path:string){const db=new DatabaseSync(path);db.exec('CREATE TABLE pending_turn (id TEXT PRIMARY KEY,payload TEXT NOT NULL,enqueued_at INTEGER NOT NULL)');return db;}
const uid=process.getuid?.()??0;
test('missing or empty legacy inbox is accepted without changing database bytes',async()=>{
 const path=await fixture();await expect(assertLegacyInboxDrained(path,uid)).resolves.toBeUndefined();
 create(path).close();const before=await readFile(path);await expect(assertLegacyInboxDrained(path,uid)).resolves.toBeUndefined();expect(await readFile(path)).toEqual(before);
});
test('pending legacy rows are refused from the current WAL snapshot without exposing payloads',async()=>{
 const path=await fixture(),db=create(path);db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
 db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run('legacy','PRIVATE BODY',123);
 try {await expect(assertLegacyInboxDrained(path,uid)).rejects.toThrow(/^Legacy inbox is not proven empty/);
  db.exec('DELETE FROM pending_turn');await expect(assertLegacyInboxDrained(path,uid)).resolves.toBeUndefined();
 }finally{db.close();}
});
test('selected asset migration cannot make a previously empty inbox safe for activation',async()=>{
 const path=await fixture(),source=`${path}.source`,checkpoint=`${path}.checkpoint`;
 create(path).close();const db=create(source);db.prepare('INSERT INTO pending_turn VALUES (?,?,?)').run('legacy','PRIVATE BODY',123);db.close();
 await expect(assertLegacyInboxDrained(path,uid)).resolves.toBeUndefined();
 await mkdir(checkpoint,{mode:0o700});
 await applyIsolatedMigration({version:1,relocations:[],assets:[{role:'inbox',source,destination:path,sourceUid:uid,uid,gid:process.getgid?.()??0,exclude:[],transforms:[]}]},checkpoint,async()=>{});
 const migrated=await readFile(path);
 await expect(assertLegacyInboxDrained(path,uid)).rejects.toThrow(/^Legacy inbox is not proven empty/);
 expect(await readFile(path)).toEqual(migrated);
 const preserved=new DatabaseSync(join(checkpoint,'migration-source-inbox'),{readOnly:true});
 try{expect(preserved.prepare('SELECT count(*) AS n FROM pending_turn').get()?.n).toBe(1);}finally{preserved.close();}
});
test('unknown schema, malformed bytes, symlinks, writable files and wrong owners fail closed',async()=>{
 const path=await fixture();await writeFile(`${path}-wal`,'orphan');await expect(assertLegacyInboxDrained(path,uid)).rejects.toThrow(/^Legacy inbox/);await rm(`${path}-wal`);await writeFile(path,'private corrupt data');await expect(assertLegacyInboxDrained(path,uid)).rejects.toThrow(/^Legacy inbox/);
 await rm(path);const db=new DatabaseSync(path);db.exec('CREATE TABLE unknown(x)');db.close();await expect(assertLegacyInboxDrained(path,uid)).rejects.toThrow(/^Legacy inbox/);
 await rm(path);create(path).close();await chmod(path,0o666);await expect(assertLegacyInboxDrained(path,uid)).rejects.toThrow(/^Legacy inbox/);
 await chmod(path,0o600);await expect(assertLegacyInboxDrained(path,uid+1)).rejects.toThrow(/^Legacy inbox/);
 await symlink(path,`${path}.link`);await expect(assertLegacyInboxDrained(`${path}.link`,uid)).rejects.toThrow(/^Legacy inbox/);
});
