import { expect, it } from 'vitest';
import { createGroupNew, GROUP_NEW_CONFIRMATION_MS, GroupNewDoc } from '../../src/durable/group-new.js';
import { Bindings } from '../../src/durable/ingress.js';

/** In-memory host exposing only the surface createGroupNew uses. */
function fixture() {
 const docs=new Map<unknown,any>([[Bindings,{epoch:1,epochs:{}}],[GroupNewDoc,{items:{}}]]);
 const controls:string[]=[];let clock=1_000_000,nextMessage=500;
 const host:any={
  administration:(fn:()=>unknown)=>fn(),
  control:async(c:{requestId:string})=>{controls.push(c.requestId);},
  runtime:{root:{id:'root',commit:async(fn:(tx:any)=>unknown)=>fn({doc:async(kind:unknown)=>docs.get(kind)})},
   harness:{snapshot:async(kind:unknown)=>kind===GroupNewDoc||kind===Bindings?docs.get(kind):undefined},store:{inbox:{pending:()=>[]}}},
 };
 const config:any={principal:'household',transport:{botId:9,allowedUserId:42},group:{chatId:-100,actors:[{id:42,label:'Isaac'},{id:43,label:'Emma'}]}};
 const ui=createGroupNew({config,host:()=>host,now:()=>clock,present:async()=>({messageId:++nextMessage})})!;
 const origin=(over:object={})=>({principal:'household',target:{chatId:-100},actorId:42,commandId:'c1',userMessageId:7,...over}) as any;
 return {ui,docs,controls,origin,tick:(ms:number)=>{clock+=ms;},bump:()=>{docs.get(Bindings).epoch++;},item:()=>Object.values(docs.get(GroupNewDoc).items)[0] as any,key:()=>Object.keys(docs.get(GroupNewDoc).items)[0]!};
}
it('expires a pending confirmation after ten minutes and binds actor and message',async()=>{
 const f=fixture();await f.ui.request!(f.origin());
 const key=f.key(),messageId=f.item().messageId;
 await expect(f.ui.decide!(f.origin({actorId:43,messageId,key,choice:'approve'}))).rejects.toThrow(/expired/);
 await expect(f.ui.decide!(f.origin({messageId:messageId+1,key,choice:'approve'}))).rejects.toThrow(/expired/);
 f.tick(GROUP_NEW_CONFIRMATION_MS+1);
 await expect(f.ui.decide!(f.origin({messageId,key,choice:'approve'}))).rejects.toThrow(/expired/);
 expect(f.controls).toEqual([]);expect(f.item().status).toBe('cancelled');
});
it('approves inside the window exactly once and replays an approved control safely',async()=>{
 const f=fixture();await f.ui.request!(f.origin());
 const key=f.key(),messageId=f.item().messageId;f.tick(GROUP_NEW_CONFIRMATION_MS-1);
 await expect(f.ui.decide!(f.origin({messageId,key,choice:'approve'}))).resolves.toMatchObject({toast:'Started'});
 expect(f.item().status).toBe('consumed');
 await expect(f.ui.decide!(f.origin({messageId,key,choice:'approve'}))).rejects.toThrow(/expired/);
 expect(f.controls).toHaveLength(1);
 // Unfinished approval after the window: same control id, no new decision.
 const g=fixture();await g.ui.request!(g.origin());
 g.item().status='approved';g.tick(GROUP_NEW_CONFIRMATION_MS*3);
 await g.ui.decide!(g.origin({messageId:g.item().messageId,key:g.key(),choice:'approve'}));
 expect(g.controls).toHaveLength(1);
 // An approved replay after the epoch moved never issues a control.
 const h=fixture();await h.ui.request!(h.origin());h.item().status='approved';h.bump();
 await expect(h.ui.decide!(h.origin({messageId:h.item().messageId,key:h.key(),choice:'approve'}))).rejects.toThrow(/expired/);
 expect(h.controls).toEqual([]);expect(h.item().status).toBe('consumed');
});
it('never confirms old pending state without a timestamp and does not re-present it',async()=>{
 const f=fixture();await f.ui.request!(f.origin());
 delete f.item().createdAt;
 await expect(f.ui.decide!(f.origin({messageId:f.item().messageId,key:f.key(),choice:'approve'}))).rejects.toThrow(/expired/);
 expect(f.controls).toEqual([]);
 const g=fixture();await g.ui.request!(g.origin());
 const item=g.item();item.messageId=null;delete item.createdAt;
 await g.ui.request!(g.origin());
 expect(item.messageId).toBeNull();expect(item.status).toBe('cancelled');
 const stale=fixture();await stale.ui.request!(stale.origin());
 await expect(stale.ui.decide!(stale.origin({messageId:stale.item().messageId,key:stale.key(),choice:'deny'}))).resolves.toMatchObject({toast:'Cancelled'});
});
