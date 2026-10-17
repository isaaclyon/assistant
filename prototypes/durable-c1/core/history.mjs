// Prototype read-only locator dispatch. The host supplies the allowed store list;
// locators never supply filesystem paths or widen the current principal scope.
import { context } from './runtime.mjs';
const {parseSessionJsonlFile}=await import(new URL('../../../src/session-jsonl-parser.ts',import.meta.url).href);
export async function resolveLocator(locator,principal,stores){
  const backend=locator.backend??'jsonl';
  if(backend!=='jsonl' && backend!=='durable')throw new Error('Unknown history backend');
  if(backend==='durable' && (!locator.instanceId || !locator.storeId))throw new Error('Native store identity required');
  const allowed=stores.filter(store=>store.backend===backend && store.principal===principal &&
    (locator.instanceId===undefined || locator.instanceId===store.instanceId) &&
    (locator.storeId===undefined || locator.storeId===store.storeId));
  if(!allowed.length)throw new Error('Unknown or unauthorized history store');
  const matches=[];
  for(const store of allowed){
    if(backend==='jsonl'){
      const parsed=await parseSessionJsonlFile({path:store.path,instanceId:store.instanceId,principal});
      matches.push(...parsed.documents.filter(e=>e.sessionId===locator.sessionId&&e.entryId===locator.entryId&&e.timestamp===locator.timestamp));
    }else{
      if(!Number.isSafeInteger(locator.conversationId)||!Number.isSafeInteger(locator.entryId))throw new Error('Invalid native locator');
      const entry=await store.p.root.commit(tx=>tx.entry(locator.entryId),context);
      if(entry && entry.conversationId===locator.conversationId && typeof entry.model?.[0]?.timestamp==='number' && new Date(entry.model[0].timestamp).toISOString()===locator.timestamp)matches.push(entry);
    }
  }
  if(matches.length!==1)throw new Error('History anchor missing or ambiguous');
  return matches[0];
}
