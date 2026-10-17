import { expect, test, vi } from 'vitest';
import type { NativeConfig } from '../../src/durable/config.js';
import { assertNativeControl, assertNativeEnvelope, bridgeTelegram, normalizeTelegramUpdate, UiRejectedError, type NativeUiController } from '../../src/durable/telegram-bridge.js';
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
