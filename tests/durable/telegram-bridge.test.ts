import { expect, test, vi } from 'vitest';
import type { NativeConfig } from '../../src/durable/config.js';
import { assertNativeControl, assertNativeEnvelope, bridgeTelegram, normalizeTelegramUpdate } from '../../src/durable/telegram-bridge.js';
const config={instanceId:'test',principal:'isaac',transport:{mode:'broker',botId:123,allowedUserId:42,socketPath:'/tmp/synthetic.sock'}} as NativeConfig;
const update={update_id:7,message:{message_id:99,date:123456,from:{id:42},chat:{id:42,type:'private'},text:'hello'}};
test('normalizes authenticated source time and identity without trusting actor text',()=>{
 const item=normalizeTelegramUpdate(config,update); expect(item).toEqual({type:'input',envelope:{instance:'test',principal:'isaac',bot:'123',chatId:42,messageIds:[99],originalAt:123456000,content:'hello'}});
 if(item.type==='input'){expect(()=>assertNativeEnvelope(config,item.envelope)).not.toThrow();expect(()=>assertNativeEnvelope(config,{...item.envelope,principal:'emma'})).toThrow(/authority/);}
 for(const message of [{...update.message,from:{id:43}},{...update.message,chat:{id:-42,type:'group'}}])expect(normalizeTelegramUpdate(config,{...update,message})).toEqual({type:'ignored'});
});
test('uses stable control IDs and drops edited messages instead of remapping source identity',()=>{
 const item=normalizeTelegramUpdate(config,{...update,message:{...update.message,text:'/new'}});
 expect(item).toEqual({type:'control',control:{type:'new',requestId:'telegram-control:123:7',principal:'isaac',target:{chatId:42}}});
 if(item.type==='control')expect(()=>assertNativeControl(config,{...item.control,target:{chatId:43}})).toThrow(/authority/);
 expect(normalizeTelegramUpdate(config,{update_id:8,edited_message:update.message})).toEqual({type:'ignored'});
 expect(normalizeTelegramUpdate(config,{...update,message:{...update.message,media_group_id:'group'}})).toMatchObject({type:'rejected',reason:expect.stringMatching(/ungrouped text/)});
});
test('awaits durable acceptance before returning to poller and preserves failure',async()=>{
 let accept!:(value:typeof update)=>Promise<void>;
 const gate=Promise.withResolvers<void>(); let returned=false;
 const raw={start:vi.fn(async(hooks:any)=>{accept=hooks.accept;return "ready" as const;}),stop:vi.fn(async()=>{}),deliver:vi.fn(async()=>55),answerCallback:vi.fn(async()=>true)};
 const transport=bridgeTelegram(config,raw,vi.fn());
 await transport.start(async()=>gate.promise,async()=>{});
 const pending=accept(update).then(()=>{returned=true;}); await Promise.resolve();expect(returned).toBe(false);gate.resolve();await pending;expect(returned).toBe(true);
 expect(await transport.sendFinal({identity:'stable',target:{chatId:42},text:'answer'})).toEqual({messageId:55});
 await expect(transport.sendFinal({identity:'stable',target:{chatId:43},text:'answer'})).rejects.toMatchObject({definitelyNotSent:true});
 expect(raw.deliver).toHaveBeenCalledTimes(1);
 await transport.start(async()=>{throw new Error('storage failure');},async()=>{});await expect(accept(update)).rejects.toThrow('storage failure');
});

test('acknowledges unsupported inputs and rejected controls without blocking later accepted work',async()=>{
 const {HostControlRejectedError}=await import('../../src/durable/host.js');
 let accept!:(value:typeof update)=>Promise<void>;
 const failure=vi.fn(),input=vi.fn(async()=>{}),control=vi.fn(async()=>{throw new HostControlRejectedError('busy');});
 const raw={start:async(hooks:any)=>{accept=hooks.accept;return 'ready' as const;},stop:async()=>{},deliver:vi.fn(async()=>{throw new Error('uncertain rejection notice');}),answerCallback:async()=>true};
 await bridgeTelegram(config,raw,failure).start(input,control);
 await expect(accept({...update,message:{...update.message,media_group_id:'group'}} as typeof update)).resolves.toBeUndefined();
 await expect(accept({...update,message:{...update.message,text:'/new'}})).resolves.toBeUndefined();
 await accept({...update,update_id:8,message:{...update.message,message_id:100}});
 expect(input).toHaveBeenCalledTimes(1);expect(control).toHaveBeenCalledTimes(1);expect(raw.deliver).toHaveBeenCalledTimes(2);expect(failure).toHaveBeenCalledTimes(2);
});
