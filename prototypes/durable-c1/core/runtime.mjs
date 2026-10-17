// Prototype-only native fixture. Uses public exports and disposable state only.
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
export const context = BACKGROUND_CONTEXT;
export async function fullStorage(path) {
  const database = await openNodeSqliteDatabase(path);
  await database.exec('PRAGMA synchronous = FULL');
  const mode = await database.get('PRAGMA synchronous');
  const journal = await database.get('PRAGMA journal_mode');
  if (mode.synchronous !== 2 || journal.journal_mode !== 'wal') throw new Error('WAL/FULL not active');
  const storage = await SqliteStorage.open(database);
  return { database, storage };
}
export async function openPilot(path, options = {}) {
  const { database, storage } = await fullStorage(path);
  const faux = fauxProvider({tokensPerSecond:1e9, tokenSize:{min:1024,max:1024}});
  const requests = [];
  faux.setResponses((options.responses ?? [fauxAssistantMessage('SYNTHETIC_FINAL')]).map(response => async (...args) => {
    requests.push(structuredClone(args[0]));
    return typeof response === 'function' ? response(...args) : response;
  }));
  const models = createModels(); models.setProvider(faux.provider);
  const registry = options.registry ?? createRegistry();
  const reports = [];
  const harness = await Harness.open(options.wrapStorage?.(storage) ?? storage, {
    models, registry, settings:{retry:{enabled:false}, compaction:{enabled:false},
      followUpMode:'one-at-a-time',steeringMode:'one-at-a-time',progress:{partialIntervalMs:0,outputIntervalMs:0}},
    onReport:error=>reports.push(error),
  }, context);
  const model = faux.getModel();
  const agent = { model:{provider:model.provider,modelId:model.id}, instructions:'SYNTHETIC_HOST_INSTRUCTIONS' };
  const root = await harness.root(context,{agent});
  return {harness,root,storage,database,models,faux,registry,reports,requests,agent,close:()=>harness.close(context)};
}
export async function wakeQueue(conversation, failedSubmissionId) {
  return conversation.submit({type:'write',requestId:`wake:${failedSubmissionId}`,
    entry:{kind:'bridge.queue-wake',model:[],data:{failedSubmissionId}}},context);
}
export function gate() {
  const {promise, resolve, reject} = Promise.withResolvers();
  return {promise,resolve,reject};
}
export async function untilReleased(hold, signal) {
  if (signal?.aborted) throw new Error('Aborted');
  let onAbort;
  const aborted = new Promise((_,reject)=>{onAbort=()=>reject(new Error('Aborted'));signal?.addEventListener('abort',onAbort,{once:true});});
  try {return await Promise.race([hold.promise,aborted]);}
  finally {signal?.removeEventListener('abort',onAbort);}
}
