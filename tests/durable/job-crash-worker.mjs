import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { appendFile,mkdir,readdir } from 'node:fs/promises';
import { fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
const [compiled,directory,phase]=process.argv.slice(2);
const {setup}=await import(pathToFileURL(join(compiled,'tests/durable/parity-application-fixture.js')).href);
const {enqueueJobHandoff}=await import(pathToFileURL(join(compiled,'src/job-handoff.js')).href);
const s=await setup('durable-jobs-test',directory);
const coordinatorStateDir=join(directory,'coordinator');await mkdir(coordinatorStateDir,{mode:0o700,recursive:true});
await enqueueJobHandoff({stateRoot:directory,coordinatorStateDir,eventId:'crash-fixture',jobId:'reminder',jobType:'at',target:'test',prompt:'Synthetic scheduled work',now:()=>new Date('2024-01-02T03:04:05.000Z')});
const paused=async()=>{await appendFile(join(directory,'barriers'),`${phase}\n`);process.send?.({type:'paused'});await new Promise(()=>{});};
const responses=phase==='effect'?[
 fauxAssistantMessage(fauxToolCall('bash',{command:`printf 'effect\\n' >> ${JSON.stringify(join(directory,'effects'))}`,timeout:5}),{stopReason:'toolUse'}),
 async()=>{await paused();return fauxAssistantMessage('UNREACHED');}
]:[fauxAssistantMessage('UNREACHED')];
await s.open(responses,false,{},undefined,async app=>{
 const runtime=app.host.runtime;
 if(phase==='claim'){
  const original=runtime.root.commit.bind(runtime.root);let fired=false;
  runtime.root.commit=async(...args)=>{
   if(!fired&&(await readdir(join(s.config.stateDir,'job-handoffs','processing')).catch(()=>[])).some(n=>n.endsWith('.json'))){fired=true;await paused();}
   return original(...args);
  };
 }
 if(phase==='admit'){
  const original=runtime.harness.conversation.bind(runtime.harness);let fired=false;
  runtime.harness.conversation=async(...args)=>{
   const conversation=await original(...args);if(!conversation)return conversation;
   return new Proxy(conversation,{get(target,key){
    if(key==='submit')return async(...submitArgs)=>{const result=await target.submit(...submitArgs);if(!fired&&submitArgs[0]?.type==='input'){fired=true;await paused();}return result;};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
   }});
  };
 }
});
