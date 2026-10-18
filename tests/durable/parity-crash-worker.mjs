import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
const [compiled,directory,phase]=process.argv.slice(2);
const {setup,fictionalWebAuth}=await import(pathToFileURL(join(compiled,'tests/durable/parity-application-fixture.js')).href);
const s=await setup('durable-parity-test',directory);
await s.open([fauxAssistantMessage(fauxToolCall('web_run',{search_query:[{q:'synthetic hosted page'}]}),{stopReason:'toolUse'}),fauxAssistantMessage('UNREACHED')],false,{webRunFetch:async()=>{
 await appendFile(join(directory,'hosted-attempts'),'attempt\n');
 if(phase==='after')await appendFile(join(directory,'hosted-effects'),'effect\n');
 process.send?.({type:'paused',phase});
 await new Promise(()=>{});
}},fictionalWebAuth);
process.send?.({type:'started'});
await s.accept('Read a hosted public page.',undefined,42,1);
