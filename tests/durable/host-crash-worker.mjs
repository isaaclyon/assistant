import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
const [compiled,path,mode]=process.argv.slice(2);
const {DurableHost}=await import(pathToFileURL(join(compiled,'src/durable/host.js')).href);
const {context}=await import(pathToFileURL(join(compiled,'src/durable/ingress.js')).href);
const send=message=>new Promise((resolve,reject)=>process.send(message,error=>error?reject(error):resolve()));
const forever=()=>new Promise(()=>{}),started=Promise.withResolvers();
const registry=createRegistry();
registry.install(defineExtension({name:'fixture',tools:[defineTool({name:'stuck',description:'synthetic noncooperative tool',parameters:Type.Object({}),replay:'safe',execute:async()=>{started.resolve();await forever();}})]}));
const faux=fauxProvider({tokensPerSecond:1e9,tokenSize:{min:1024,max:1024}});
faux.setResponses((mode==='fatal'||mode==='control-timeout')?[answer(fauxToolCall('stuck',{}),{stopReason:'toolUse'})]:[forever]);
const models=createModels();models.setProvider(faux.provider);const model=faux.getModel();let reports=0;
const host=await DurableHost.create({stateDir:path,models,registry,agent:{model:{provider:model.provider,modelId:model.id}},compatibility:{runtimeGeneration:'pi-durable-1.3.0',releaseSchema:1,profile:'fixture',registrySignature:'fixture-v1'},transport:{async start(){},async stop(){},async sendFinal(){return {messageId:1};}},policy(){},controlPolicy(){},closeTimeoutMs:100,onFatal(){reports++;setTimeout(()=>process.exit(42),150);},settings:{retry:{enabled:false},compaction:{enabled:false}}});
const envelope={instance:'test',principal:'person',bot:'bot',chatId:10,threadId:2,messageIds:[1],originalAt:1700000000001,content:'input 1'};
if(mode==='admitted')host.runtime.store.inbox.remove=()=>{void send({event:'admitted'});};
await host.receive(envelope);
if(mode==='control-timeout'){
  await started.promise;let rejected=false;try{await host.abort('abort-fixture','person',{chatId:10,threadId:2});}catch{rejected=true;}
  await send({event:'control-timeout',health:host.health,rejected,reports});
}else if(mode==='fatal'){
  await started.promise;
  host.runtime.store.storage.commit=async()=>{throw new Error('SYNTHETIC_STORAGE_FAILURE');};
  let rejected=false,laterRejected=false;
  try{await host.receive({...envelope,messageIds:[2],content:'MUST_NOT_ACCEPT'});}catch{rejected=true;}
  try{await host.receive({...envelope,messageIds:[3],content:'MUST_NOT_ACCEPT'});}catch{laterRejected=true;}
  await send({event:'failed-closed',health:host.health,rejected,laterRejected,reports});
}else if(mode==='writer'){await host.reconcile();await send({event:'writer'});}
await forever();
