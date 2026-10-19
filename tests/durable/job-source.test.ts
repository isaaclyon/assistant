import { createHash } from 'node:crypto';
import { expect,test } from 'vitest';
import { fingerprint,normalize,sourceKey,type SourceEnvelope } from '../../src/durable/ingress.js';
import { assertNativeEnvelope } from '../../src/durable/telegram-bridge.js';
const human:SourceEnvelope={instance:'fixture',principal:'isaac',bot:'123',chatId:42,messageIds:[1],originalAt:1700000000000,content:'hello'};
const job:SourceEnvelope={...human,messageIds:[],proactive:true,job:{dispatchId:`reminder-${'a'.repeat(16)}`,jobId:'reminder',createdAt:new Date(human.originalAt).toISOString()}};

test('existing human source keys and fingerprints stay byte-compatible; jobs use explicit dispatch identities',()=>{
 const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
 expect(sourceKey(human)).toBe(hash(['fixture','isaac','123',42,null,[1]]));
 expect(fingerprint(human)).toBe(hash({...human,proactive:false,attachments:[]}));
 expect(sourceKey(job)).toBe(hash(['fixture','isaac','123','job',job.job!.dispatchId]));
 expect(sourceKey({...job,chatId:99})).toBe(sourceKey(job));
 expect(fingerprint({...job,chatId:99})).not.toBe(fingerprint(job));
 expect(sourceKey({...job,instance:'peer'})).not.toBe(sourceKey(job));
 expect(sourceKey({...job,bot:'456'})).not.toBe(sourceKey(job));
 expect(normalize(job).job).toEqual(job.job);
});

test('job envelopes require exact source metadata, original time and proactive ownership',()=>{
 const variants=[{proactive:false},{messageIds:[1]},{attachments:[{text:'x'}]},{originalAt:human.originalAt+1},{job:{...job.job!,dispatchId:'../escape'}},{job:{...job.job!,jobId:'elsewhere'}},{job:{...job.job!,createdAt:'invalid'}},{job:{...job.job!,jobType:'unknown'}},{job:{...job.job!,extra:'unknown'}}];
 for(const variant of variants)expect(()=>normalize({...job,...variant} as SourceEnvelope)).toThrow();
 expect(()=>normalize({...human,messageIds:[]})).toThrow();
});

test('only the explicit private recipient profile can recover proactive job sources',()=>{
 const config:any={instanceId:'fixture',principal:'isaac',capabilityProfile:'durable-jobs-test',jobsRole:'recipient',transport:{botId:123,allowedUserId:42}};
 expect(()=>assertNativeEnvelope(config,job)).not.toThrow();
 expect(()=>assertNativeEnvelope(config,human)).not.toThrow();
 for(const changes of [{capabilityProfile:'durable-parity-test'},{jobsRole:'disabled'}])expect(()=>assertNativeEnvelope({...config,...changes},job)).toThrow(/authority/);
 for(const changes of [{chatId:99},{threadId:2},{instance:'peer'},{principal:'emma'},{bot:'456'},{proactive:false},{job:undefined}])expect(()=>assertNativeEnvelope(config,{...job,...changes})).toThrow(/authority/);
});
