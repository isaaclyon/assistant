import { loadPinnedNativeConfig } from './config.js';
import { createNativeApplication } from './application.js';

const path=process.env.PI_DURABLE_CONFIG;
if(!path)throw new Error('PI_DURABLE_CONFIG must name a private native configuration');
process.umask(0o077);
const config=await loadPinnedNativeConfig(path);
const application=await createNativeApplication(config,{onFatal:()=>{process.exitCode=1;},onTransportFailure:()=>{}});
try {
 const canary=process.argv.indexOf('--canary-dispatch');
 if(canary>=0){
  const {inspectScheduledCompletion}=await import('./canary-proof.js');
  console.log(JSON.stringify(await inspectScheduledCompletion(application.host.runtime,process.argv[canary+1]??'')));
 } else if(process.argv.slice(2).includes('--lint-memory')) {
  // Uses the same scoped resolver as live search; no scheduler or poller starts.
  console.log(JSON.stringify(await application.lintMemory(),null,2));
 } else {
  const recovery=await application.host.inspect();
  // Deliberately omit prompts, tool inputs, model responses, credentials and targets.
  console.log(JSON.stringify({runtime:'pi-durable',instanceId:config.instanceId,pendingInbox:recovery.pendingInbox,jobs:await application.inspectJobs(),children:await application.inspectChildren(),uncertainDeliveries:recovery.uncertain,taskStates:recovery.inspection.tasks.map(task=>({id:task.record.id,kind:task.record.kind,state:task.state.kind}))},null,2));
 }
} finally {await application.close();}
