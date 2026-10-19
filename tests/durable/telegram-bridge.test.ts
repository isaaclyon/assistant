import { expect, test, vi } from 'vitest';
import type { NativeConfig } from '../../src/durable/config.js';
import { assertNativeControl, assertNativeEnvelope, bridgeTelegram, normalizeTelegramUpdate, UiRejectedError, type NativeUiController } from '../../src/durable/telegram-bridge.js';
const config={instanceId:'test',principal:'isaac',capabilityProfile:'durable-chat-memory-test',jobsRole:'disabled',transport:{mode:'broker',botId:123,allowedUserId:42,socketPath:'/tmp/synthetic.sock'}} as NativeConfig;
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

const callbackUpdate=(data:string,over:Record<string,unknown>={})=>({update_id:20,callback_query:{id:'cb1',data,from:{id:42},message:{message_id:300,chat:{id:42,type:'private'}},...over}});
function harness(ui:Partial<NativeUiController>={},extra:Record<string,unknown>={}){
 let hooks!:any;const calls:string[]=[];
 const raw={start:vi.fn(async(h:any)=>{hooks=h;return 'ready' as const;}),stop:vi.fn(async()=>{}),deliver:vi.fn(async(_t:any,text:string)=>{calls.push(`deliver:${text}`);return 1;}),
  answerCallback:vi.fn(async(_id:string,text:string)=>{calls.push(`answer:${text}`);return true;}),present:vi.fn(async(_t:any,p:any)=>{calls.push(`present:${p.text.split('\n')[0]}`);return 77;}),
  edit:vi.fn(async(_t:any,_id:number,p:any)=>{calls.push(`edit:${p.text.split('\n')[0]}`);}),preview:vi.fn(async()=>{})};
 const controller:NativeUiController={command:vi.fn(async r=>r.name==='menu'?{view:{kind:'menu' as const,state:{model:'m'}}}:{toast:'done'}),confirmation:vi.fn(async()=>({toast:'ok'})),...ui};
 const control=vi.fn(async()=>{});
 const transport=bridgeTelegram(config,raw as any,vi.fn(),{ui:controller,...extra});
 return {raw,controller,control,calls,transport,start:async()=>{await transport.start(async()=>{},control);return hooks;}};
}
test('callbacks normalize to trusted identity and ignore other actors and chats',()=>{
 const ok=normalizeTelegramUpdate(config,callbackUpdate('tl:max'));
 expect(ok).toEqual({type:'callback',callback:{id:'cb1',commandId:'telegram-callback:123:20',actorId:42,principal:'isaac',target:{chatId:42},messageId:300,data:'tl:max',action:{type:'thinking',level:'max'}}});
 expect(normalizeTelegramUpdate(config,callbackUpdate('tl:max',{from:{id:43}}))).toEqual({type:'ignored'});
 expect(normalizeTelegramUpdate(config,callbackUpdate('tl:max',{message:{message_id:3,chat:{id:-5,type:'group'}}}))).toEqual({type:'ignored'});
 expect(normalizeTelegramUpdate(config,callbackUpdate('tl:max',{message:{message_id:3,chat:{id:42,type:'private'},message_thread_id:9}}))).toMatchObject({callback:{action:undefined}});
 expect(normalizeTelegramUpdate(config,callbackUpdate('<script>'))).toMatchObject({callback:{action:undefined}});
});
test('unknown slash commands are refused, never forwarded',async()=>{
 const h=harness();const hooks=await h.start();let forwarded=0;
 await h.transport.start(async()=>{forwarded++;},h.control);
 await hooks.accept({...update,message:{...update.message,text:'/frobnicate'}});
 expect(forwarded).toBe(0);expect(h.raw.deliver).toHaveBeenCalledWith({chatId:42},expect.stringMatching(/Unknown command/));
});
test('model and thinking selection return to the status menu by editing the pressed message',async()=>{
 const h=harness();const hooks=await h.start();
 await hooks.accept(callbackUpdate('mc:gpt-x'));
 expect(h.controller.command).toHaveBeenNthCalledWith(1,expect.objectContaining({name:'selectModel',arg:'gpt-x',commandId:'telegram-callback:123:20',messageId:300,principal:'isaac'}));
 expect(h.controller.command).toHaveBeenNthCalledWith(2,expect.objectContaining({name:'menu'}));
 expect(h.calls).toEqual(['answer:done','edit:Assistant']);
 h.calls.length=0;await hooks.accept(callbackUpdate('tl:max'));
 expect(h.controller.command).toHaveBeenCalledWith(expect.objectContaining({name:'selectThinking',arg:'max'}));expect(h.calls).toEqual(['answer:done','edit:Assistant']);
});
test('/new shows the menu on success and not when rejected; callback controls use stable ids',async()=>{
 const {HostControlRejectedError}=await import('../../src/durable/host.js');
 const h=harness();const hooks=await h.start();
 await hooks.accept({...update,message:{...update.message,text:'/new'}});
 expect(h.control).toHaveBeenCalledWith(expect.objectContaining({type:'new',requestId:'telegram-control:123:7'}));expect(h.calls).toEqual(['present:Assistant']);
 h.calls.length=0;h.control.mockRejectedValueOnce(new HostControlRejectedError('busy'));
 await hooks.accept(callbackUpdate('k:new'));
 expect(h.calls).toEqual(['answer:busy']);
 await hooks.accept(callbackUpdate('k:compact'));expect(h.control).toHaveBeenLastCalledWith({type:'compact',requestId:'telegram-control:123:20',principal:'isaac',target:{chatId:42}});
});
test('confirmation callbacks pass trusted identity; refusals acknowledge, storage errors do not',async()=>{
 const h=harness({confirmation:vi.fn(async()=>{throw new UiRejectedError('Expired');})});const hooks=await h.start();
 await expect(hooks.accept(callbackUpdate('cf:a:abcdefgh12345678'))).resolves.toBeUndefined();
 expect(h.controller.confirmation).toHaveBeenCalledWith(expect.objectContaining({key:'abcdefgh12345678',choice:'approve',actorId:42,messageId:300,principal:'isaac',target:{chatId:42},commandId:'telegram-callback:123:20'}));
 expect(h.calls).toEqual(['answer:Expired']);
 const failing=harness({confirmation:vi.fn(async()=>{throw new Error('storage');})});const fh=await failing.start();
 await expect(fh.accept(callbackUpdate('cf:d:abcdefgh12345678'))).rejects.toThrow('storage');
 await expect(hooks.accept(callbackUpdate('cf:a:bad'))).resolves.toBeUndefined();
});
test('debug output is redacted, bounded and sent to the originating private target only',async()=>{
 const h=harness({command:vi.fn(async()=>({view:{kind:'diagnostics' as const,sections:[{title:'Tools',lines:['token=supersecretvalue ok','x'.repeat(5000)]}]}}))});const hooks=await h.start();
 await hooks.accept({...update,message:{...update.message,text:'/debug'}});
 const [target,presentation]=h.raw.present.mock.calls[0] as any[];
 expect(target).toEqual({chatId:42});expect(presentation.text).not.toContain('supersecretvalue');expect(presentation.text.length).toBeLessThanOrEqual(3500);
});
test('command failures are acknowledged; restart is deferred until the offset is acknowledged and dropped on failure',async()=>{
 const ran=vi.fn();
 const h=harness({command:vi.fn(async()=>({toast:'x',afterAcknowledgement:ran}))});const hooks=await h.start();
 await hooks.accept({...update,message:{...update.message,text:'/restart'}});expect(ran).not.toHaveBeenCalled();
 await hooks.acknowledged(7);expect(ran).toHaveBeenCalledTimes(1);await hooks.acknowledged(7);expect(ran).toHaveBeenCalledTimes(1);
 const bad=harness({command:vi.fn(async()=>{throw new Error('boom internal path /Users/x');})});const bh=await bad.start();
 await expect(bh.accept({...update,message:{...update.message,text:'/reload'}})).resolves.toBeUndefined();
 expect(bad.raw.deliver).toHaveBeenCalledWith({chatId:42},'Command failed.');
});
test('presenter and stream only serve the instance private target',async()=>{
 const h=harness();await h.start();
 expect(await h.transport.presenter.present({chatId:42},{text:'x'})).toEqual({messageId:77});
 await expect(h.transport.presenter.present({chatId:43},{text:'x'})).rejects.toMatchObject({definitelyNotSent:true});
 h.transport.stream.update({chatId:43},'t','hidden');await h.transport.stream.finish({chatId:43},'t');
 expect(h.raw.preview).not.toHaveBeenCalled();
});

test.each([['places','pp'],['calendar','gc']] as const)('%s callbacks carry authenticated message identity through a bounded grammar',async(name,prefix)=>{
 const handler=vi.fn(async()=>({toast:'Saved'}));const h=harness({[name]:handler});const hooks=await h.start();
 const key='a'.repeat(32);await hooks.accept(callbackUpdate(`${prefix}:${key}`));
 expect(handler).toHaveBeenCalledWith({commandId:'telegram-callback:123:20',principal:'isaac',actorId:42,target:{chatId:42},messageId:300,key});
 for(const data of [`${prefix}:unsafe`,`${prefix}:${key}:extra`,`${prefix}:${key.toUpperCase()}`])await hooks.accept(callbackUpdate(data));
 await hooks.accept(callbackUpdate(`${prefix}:${key}`,{from:{id:99}}));await hooks.accept(callbackUpdate(`${prefix}:${key}`,{message:{message_id:300,chat:{id:43,type:'private'}}}));
 expect(handler).toHaveBeenCalledTimes(1);
 const failing=harness({[name]:async()=>{throw new Error('storage');}});const failed=await failing.start();
 await expect(failed.accept(callbackUpdate(`${prefix}:${key}`))).rejects.toThrow('storage');
});

test('places exact reply capture consumes handled input and never admits it to the model',async()=>{
 const placesInput=vi.fn(async()=>true);const h=harness({placesInput});await h.start();const admitted=vi.fn(async()=>{});
 await h.transport.start(admitted,h.control);const hooks=h.raw.start.mock.calls.at(-1)![0];
 const reply={...update,message:{...update.message,text:'Synthetic name',reply_to_message:{message_id:200}}};await hooks.accept(reply);
 expect(placesInput).toHaveBeenCalledWith({commandId:'telegram-reply:123:7',principal:'isaac',actorId:42,target:{chatId:42},messageId:99,replyToMessageId:200,text:'Synthetic name'});expect(admitted).not.toHaveBeenCalled();
 placesInput.mockResolvedValue(false);await hooks.accept({...reply,update_id:8});expect(admitted).toHaveBeenCalledTimes(1);
 placesInput.mockRejectedValue(new Error('durable capture failed'));await expect(hooks.accept({...reply,update_id:9})).rejects.toThrow('durable capture failed');expect(admitted).toHaveBeenCalledTimes(1);
 await hooks.accept({...reply,update_id:10,message:{...reply.message,from:{id:99}}});expect(placesInput).toHaveBeenCalledTimes(3);
});

test('places command visibility follows the selected profile',async()=>{
 const h=harness({}, {commands:['menu','new']});const hooks=await h.start();await hooks.accept({...update,message:{...update.message,text:'/place_rankings'}});
 expect(h.controller.command).not.toHaveBeenCalled();expect(h.raw.deliver).toHaveBeenCalledWith({chatId:42},expect.stringContaining('unavailable'));
});

test('only exact private bot quotes carry a prompt reference to places capture',async()=>{
 const placesInput=vi.fn(async(_request:unknown)=>true);const h=harness({placesInput});const hooks=await h.start();
 const quoted={message_id:50,from:{id:123,is_bot:true},chat:{id:42,type:'private'},text:'A synthetic prompt'};
 const accept=(reply:unknown)=>hooks.accept({...update,message:{...update.message,reply_to_message:reply}});
 await accept(quoted);expect(placesInput.mock.calls.at(-1)?.[0]).toMatchObject({trustedPromptText:quoted.text});
 for(const reply of [{...quoted,from:{id:42,is_bot:false}},{...quoted,from:{id:124,is_bot:true}},{...quoted,chat:{id:43,type:'private'}},{...quoted,chat:{id:42,type:'group'}}]){
  await accept(reply);expect(placesInput.mock.calls.at(-1)?.[0]).not.toHaveProperty('trustedPromptText');
 }
});

test('tool activity port is silent, private-target-only and absent for households',async()=>{
 const call=vi.fn(async(method:string)=>({status:200,payload:{ok:true,result:method==='sendMessage'?{message_id:9}:true}}));
 const raw={start:async()=>'ready' as const,stop:async()=>{},deliver:async()=>1,answerCallback:async()=>true,media:{call}} as any;
 const {activity}=bridgeTelegram(config,raw,vi.fn());
 expect(await activity.send({chatId:42},'Working')).toBe(9);
 expect(call).toHaveBeenCalledWith('sendMessage',{chat_id:42,text:'Working',disable_notification:true});
 await activity.edit({chatId:42},9,'More');await activity.remove({chatId:42},9);
 expect(call.mock.calls.map(c=>c[0])).toEqual(['sendMessage','editMessageText','deleteMessage']);
 call.mockClear();
 expect(await activity.send({chatId:43},'x')).toBeUndefined();expect(await activity.send({chatId:42,threadId:1},'x')).toBeUndefined();
 const group=bridgeTelegram({...config,group:{} } as any,raw,vi.fn()).activity;
 expect(await group.send({chatId:42},'x')).toBeUndefined();expect(call).not.toHaveBeenCalled();
});
