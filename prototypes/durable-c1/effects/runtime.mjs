import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineExtension, defineTool, defineDoc, AssistantEntry, ToolTask } from '@earendil-works/pi-durable';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
export { context };
/** @typedef {{operation: null | {id:string, fingerprint:string, status:string, taskId:number}, approval:null | {token:string,actor:string,chat:string,epoch:string,revision:string,version:number,expiresAt:number,presented:boolean,consumed:boolean}, epoch:string, revoked:boolean}} EffectState */
/** @type {import('@earendil-works/pi-durable').ConversationDocToken<EffectState>} */
export const State = defineDoc({kind:'c1.effect',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({operation:null,approval:null,epoch:'epoch-1',revoked:false})});
export function externalState(dir) {
 const db = new DatabaseSync(join(dir,'external.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT OR IGNORE INTO counter VALUES (1,0); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL)');
 return db;
}
export async function open(dir, {killPoint=false, missingReceipt=false}={}) {
 const external=externalState(dir);
 const registry=createRegistry();
 registry.install(defineExtension({name:'c1-effects',tools:[defineTool({name:'synthetic_mutation',description:'Synthetic external mutation',parameters:Type.Object({operationId:Type.String(),fingerprint:Type.String()}),replay:'safe',execute:async(args,api)=>{
   const prior = await api.commit(async tx=>{
     const state=await tx.doc(State,api.conversationId);
     if(state.operation) { assert.equal(state.operation.id,args.operationId); assert.equal(state.operation.fingerprint,args.fingerprint); return state.operation.status; }
     state.operation={id:args.operationId,fingerprint:args.fingerprint,status:'executing',taskId:api.taskId};
     return 'prepared';
   },context);
   const receipt=external.prepare('SELECT fingerprint FROM receipts WHERE id=?').get(args.operationId);
   let outcome;
   if(receipt) { assert.equal(receipt.fingerprint,args.fingerprint); outcome='reconciled'; }
   else if(prior!=='prepared') outcome='uncertain';
   else {
     external.exec('BEGIN IMMEDIATE');
     try {
       external.exec('UPDATE counter SET value=value+1 WHERE id=1');
       if(!missingReceipt) external.prepare('INSERT INTO receipts VALUES (?,?)').run(args.operationId,args.fingerprint);
       external.exec('COMMIT');
     } catch(e) {external.exec('ROLLBACK');throw e;}
     if(killPoint) { process.send?.({event:'external-succeeded',taskId:api.taskId}); await new Promise(()=>{}); }
     outcome='succeeded';
   }
   await api.commit(async tx=>{(await tx.doc(State,api.conversationId)).operation.status=outcome;},context);
   return {output:[{type:"text",text:outcome}],details:{operationId:args.operationId,outcome},control:{terminate:true}};
 }})]}));
 const db=await openNodeSqliteDatabase(join(dir,'native.sqlite'));
 await db.exec('PRAGMA synchronous=FULL');
 assert.equal((await db.get('PRAGMA journal_mode')).journal_mode,'wal');
 assert.equal((await db.get('PRAGMA synchronous')).synchronous,2);
 const harness=await Harness.open(await SqliteStorage.open(db),{models:createModels(),registry},context);
 const root=await harness.root(context);
 return {harness,root,external,close:async()=>{await harness.close(context);external.close();}};
}
export async function enqueue(tx, rootId, operationId='operation-1') {
 const message={role:'assistant',content:[{type:'toolCall',id:'call-1',name:'synthetic_mutation',arguments:{operationId,fingerprint:'synthetic-increment-v1'}}],api:'openai-responses',provider:'synthetic',model:'fixture',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',timestamp:1};
 const entry=await tx.appendEntry(AssistantEntry,rootId,{model:[message]});
 return tx.createTask(ToolTask,{kind:'model',assistant:entry.id,callId:'call-1'},{ownership:{kind:'conversation'},conversationId:rootId});
}
export async function prepareApproval(app, now=1000) {
 await app.root.commit(async tx=>{(await tx.doc(State,app.root.id)).approval={token:'synthetic-token',actor:'actor-1',chat:'chat-1',epoch:'epoch-1',revision:'rev-1',version:1,expiresAt:now+600000,presented:true,consumed:false};},context);
}
// Authenticated actor/chat are supplied by a trusted adapter, never the callback payload.
export async function callback(app, change={}) {
 const input={token:'synthetic-token',actor:'actor-1',chat:'chat-1',epoch:'epoch-1',revision:'rev-1',version:1,now:1001,...change};
 return app.root.commit(async tx=>{
  const state=await tx.doc(State,app.root.id); const a=state.approval;
  if(!a || !a.presented || a.consumed || state.revoked || input.now>=a.expiresAt || state.epoch!==a.epoch || ['token','actor','chat','epoch','revision','version'].some(key=>a[key]!==input[key])) return {accepted:false};
  a.consumed=true;
  const taskId=await enqueue(tx,app.root.id);
  return {accepted:true,taskId};
 },context);
}
