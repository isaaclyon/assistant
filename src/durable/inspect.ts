import { loadNativeConfig } from './config.js';
import { createNativeApplication } from './application.js';

const path=process.env.PI_DURABLE_CONFIG;
if(!path)throw new Error('PI_DURABLE_CONFIG must name a private native configuration');
process.umask(0o077);
const config=await loadNativeConfig(path);
const application=await createNativeApplication(config,{onFatal:()=>{process.exitCode=1;},onTransportFailure:()=>{}});
try {
 const recovery=await application.host.inspect();
 // Deliberately omit prompts, tool inputs, model responses, credentials and targets.
 console.log(JSON.stringify({runtime:'pi-durable',instanceId:config.instanceId,pendingInbox:recovery.pendingInbox,uncertainDeliveries:recovery.uncertain,taskStates:recovery.inspection.tasks.map(task=>({id:task.record.id,kind:task.record.kind,state:task.state.kind}))},null,2));
} finally {await application.close();}
