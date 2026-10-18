import { AgentDoc, Harness, InboxDoc, LiveDoc, defineDoc, type AgentChange, type ConversationId, type HarnessOptions, type SubmissionId, type TaskId, type Tx } from '@earendil-works/pi-durable';
import { InboxStorageError, openHostStorage } from './storage.js';
import { accept, admit, Bindings, context, normalize, type IngressRuntime, type InputAdapter, type SourceEnvelope, type Target } from './ingress.js';
import { reconcileDeliveries, type FinalSender } from './delivery.js';
import { assertInboxBound, assertTaskMigrationsRunnable, inspectRecovery, wakeFailedQueues } from './recovery.js';
/** A rejected user control is terminal at ingress; storage failures still propagate. */
export class HostControlRejectedError extends Error {}
const busyControlError=()=>new HostControlRejectedError('Cannot start a new conversation while busy. Wait for pending work to finish or use /stop.');
export type HostControl={type:'new'|'abort'|'stop'|'compact';requestId:string;principal:string;target:Target};
export interface HostTransport {
  start(onEnvelope:(envelope:SourceEnvelope)=>Promise<void>,onControl:(control:HostControl)=>Promise<void>):Promise<void>;
  stop():Promise<void>;
  sendFinal:FinalSender;
}
export type HostCompatibility={runtimeGeneration:string;releaseSchema:number;profile:string;registrySignature:string};
type ControlRecord={control:HostControl;conversationId:ConversationId|null;taskIds:TaskId[];submissionIds:SubmissionId[];status:'pending'|'executing'|'done'|'uncertain'|'rejected'};
export const HostState=defineDoc({kind:'bridge.host',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({compatibility:null as HostCompatibility|null,controls:{} as Record<string,ControlRecord>})});
export interface HostConfig {
  stateDir:string;
  inboxPath?:string;
  models:HarnessOptions['models'];
  registry:HarnessOptions['registry'];
  agent:AgentChange;
  compatibility:HostCompatibility;
  transport:HostTransport;
  /** Checks instance, bot, principal and target, on acceptance and recovery. */
  policy:(envelope:SourceEnvelope,phase?:'recovery')=>void|Promise<void>;
  controlPolicy:(control:HostControl)=>void|Promise<void>;
  onEpochChange?:(tx:Tx,previousConversationIds:ConversationId[],nextEpoch:number)=>Promise<void>;
  recoveryPreflight?:(harness:Harness)=>Promise<void>;
  /** Attach best-effort UI observers before any admitted input starts execution. */
  onConversation?:(conversationId:ConversationId)=>Promise<void>;
  /** Runs on the acceptance line, before queued input admission. */
  beforeAdmission?:()=>Promise<void>;
  /** Trusted source adapters run on the same line as acceptance and rotation. */
  reconcileSources?:(runtime:IngressRuntime)=>Promise<void>;
  /** Verify retained source artifacts and construct actual model input on every admission path. */
  inputAdapter?:InputAdapter;
  /** Operation-owned output ledgers run after authoritative final-text settlement. */
  reconcileOutputs?:()=>Promise<void>;
  onFatal?:(error:unknown)=>void;
  closeTimeoutMs?:number;
  reconcileIntervalMs?:number;
  idleMs?:number;
  settings?:HarnessOptions['settings'];
  env?:HarnessOptions['env'];
}
export class DurableHost {
  private line:Promise<unknown>=Promise.resolve();
  private closing=false;
  private failed=false;
  private started=false;
  private timer:ReturnType<typeof setInterval>|undefined;
  private closingPromise:Promise<void>|undefined;
  private reconcilePending:Promise<void>|undefined;
  private dirty=false;
  private validated=false;
  private constructor(readonly config:HostConfig,readonly runtime:IngressRuntime){}
  get health(){return this.failed?'failed':this.closing?'closing':this.started?'ready':'created';}
  static async create(config:HostConfig):Promise<DurableHost>{
    const store=await openHostStorage(config.stateDir,config.inboxPath);
    let harness:Harness|undefined;
    try{
      harness=await Harness.open(store.storage,{models:config.models,registry:config.registry,env:config.env,settings:{...config.settings,followUpMode:'one-at-a-time',steeringMode:'one-at-a-time'}},context);
      const root=await harness.root(context,{agent:config.agent});
      await root.commit(async tx=>{const state=await tx.doc(HostState,root.id);if(state.compatibility&&JSON.stringify(state.compatibility)!==JSON.stringify(config.compatibility))throw new Error('Incompatible native host metadata');state.compatibility=config.compatibility;},context);
      const host=new DurableHost(config,{harness,root,store,agent:config.agent,...(config.onEpochChange?{onEpochChange:config.onEpochChange}:{})});
      harness.subscribeClose(()=>{if(!host.closing)host.fatal(new Error('Native storage/session closed unexpectedly'));});
      harness.subscribeCommits(publication=>{
        if(publication.changes.some(change=>change.type==='submission'&&change.value.type==='input'&&(change.value.status==='done'||change.value.status==='unanswered')))host.signalReconcile();
      });
      return host;
    }catch(error){if(harness)await harness.close(context);else await store.storage.close(context);store.release();throw error;}
  }
  private report(error:unknown){try{this.config.onFatal?.(error);}catch{/* Reporting cannot defeat fail-closed cleanup. */}}
  private fatal(error:unknown){if(this.failed)return;this.failed=true;this.report(error);void this.close().catch(()=>{});}
  private serialize<T>(operation:()=>Promise<T>):Promise<T>{const result=this.line.then(operation);this.line=result.catch(()=>{});return result;}
  private assertOpen(){if(this.closing||this.failed)throw new Error('Host is not accepting work');}
  private async preflight(){
    const {harness,root}=this.runtime;
    await assertInboxBound(this.runtime);
    const recovery=await inspectRecovery(this.runtime);
    if(recovery.inspection.tasks.some(task=>task.state.kind==='blocked'))throw new Error('Recovery blocked: missing or incompatible task definition');
    const state=await harness.snapshot(Bindings,root.id,context),registry=this.config.registry.snapshot();
    assertTaskMigrationsRunnable(recovery.inspection,registry);
    await this.config.recoveryPreflight?.(harness);
    for(const binding of Object.values(state?.sources??{}))await this.config.policy(binding.envelope,'recovery');
    for(const id of [root.id,...Object.values(state?.epochs??{})]){
      const agent=await harness.snapshot(AgentDoc,id,context);
      const extensions=Array.isArray(agent?.extensions)?agent.extensions:agent?.extensions?.add??[];
      const tools=Array.isArray(agent?.tools)?agent.tools:[];
      if(extensions.some(name=>!registry.extension(name))||tools.some(name=>!registry.tools().some(item=>item.tool.name===name)))throw new Error('Stored agent selection is unavailable');
    }
    for(const record of Object.values((await harness.snapshot(HostState,root.id,context))?.controls??{}))if(record.status==='pending'||record.status==='executing')await this.config.controlPolicy(record.control);
    const active = state?.epochs[String(state.epoch)];
    if (active !== undefined) await this.config.onConversation?.(active);
  }
  /** Narrow read-only inbox inspection. Full startup uses validateRecovery. */
  validateInbox():Promise<void>{return this.serialize(()=>assertInboxBound(this.runtime));}
  /** Validate all stored authority and task migrations before another scheduler starts. */
  validateRecovery():Promise<void>{return this.serialize(async()=>{this.assertOpen();await this.preflight();this.validated=true;});}
  private signalReconcile(){
    if(this.closing||this.failed||!this.started)return;
    this.dirty=true;
    queueMicrotask(()=>{if(!this.closing&&!this.failed)void this.reconcile().catch(error=>this.fatal(error));});
  }
  async start(){
    this.assertOpen();if(this.started)return;
    if(!this.validated){await this.preflight();this.validated=true;}
    // Callbacks are bound only after validation. Sender is supplied before recovery.
    try{
      await this.config.transport.start(e=>this.receive(e),c=>this.control(c));
      this.started=true;
      await this.reconcile();
      this.runtime.harness.resume();
    }catch(error){this.fatal(error);throw error;}
    this.timer=setInterval(()=>{void this.reconcile().catch(error=>this.fatal(error));},this.config.reconcileIntervalMs??1000);this.timer.unref();
  }
  /** Resolves after binding AND inbox persistence. Admission runs after acceptance. */
  async receive(input:SourceEnvelope){
    this.assertOpen();const envelope=normalize(input);await this.config.policy(envelope);
    try{await this.serialize(async()=>{this.assertOpen();if(!this.validated){await this.preflight();this.validated=true;}const accepted=await accept(this.runtime,envelope,this.config.idleMs);await this.config.onConversation?.(accepted.binding.conversationId);});}
    catch(error){if(error instanceof InboxStorageError)this.fatal(error);throw error;}
    void this.reconcile().catch(error=>this.fatal(error));
  }
  reconcile():Promise<void>{
    if(this.reconcilePending)return this.reconcilePending;
    const work=this.serialize(async()=>{
      this.assertOpen();
      if(!this.validated){await this.preflight();this.validated=true;}
      this.dirty=false;
      await this.recoverControls();
      await this.config.beforeAdmission?.();
      await this.config.reconcileSources?.(this.runtime);
      for(const row of this.runtime.store.inbox.pending()){
        const envelope=normalize(JSON.parse(row.payload) as SourceEnvelope);await this.config.policy(envelope);await admit(this.runtime,envelope,this.config.inputAdapter);
      }
      await wakeFailedQueues(this.runtime);
      await reconcileDeliveries(this.runtime,this.config.transport.sendFinal.bind(this.config.transport));
      await this.config.reconcileOutputs?.();
    });
    this.reconcilePending=work;void work.finally(()=>{this.reconcilePending=undefined;if(this.dirty&&!this.closing&&!this.failed)this.signalReconcile();}).catch(()=>{});return work;
  }
  private async prepareControl(control:HostControl){
    const {harness,root}=this.runtime;
    const prior=(await harness.snapshot(HostState,root.id,context))?.controls[control.requestId];
    if(prior){if(JSON.stringify(prior.control)!==JSON.stringify(control))throw new Error('Control payload conflict');if(prior.status==='rejected')throw busyControlError();return;}
    const buffered=this.runtime.store.inbox.pending().length;
    const rejected=await root.commit(async tx=>{
      const state=await tx.doc(HostState,root.id),sources=await tx.doc(Bindings,root.id);
      const conversationId=sources.epochs[String(sources.epoch)]??null;
      const ids=control.type==='stop'?Object.values(sources.epochs):conversationId===null?[]:[conversationId];
      const taskIds:TaskId[]=[],submissionIds:SubmissionId[]=[];
      let queued=false;
      // Capture the exact work on the native transaction line, with no scheduler race.
      for(const id of ids){
        const live=await tx.doc(LiveDoc,id),inbox=await tx.doc(InboxDoc,id);
        if(live.run)taskIds.push(live.run.taskId);
        for(const compaction of live.compactions??[])taskIds.push(compaction.taskId);
        queued ||= inbox.items.length>0;
        if(control.type==='stop')submissionIds.push(...inbox.items.filter(item=>item.mode!=='write').map(item=>item.id));
      }
      if(control.type==='new'&&(taskIds.length||buffered||queued)){
        state.controls[control.requestId]={control,conversationId,taskIds:[],submissionIds:[],status:'rejected'};
        return true;
      }
      if(control.type==='stop')for(const binding of Object.values(sources.sources))if(binding.submissionId===undefined)binding.cancelled=true;
      if(control.type==='new'){sources.lastHumanAt=0;sources.epoch++;sources.rotations[control.requestId]=sources.epoch;await this.config.onEpochChange?.(tx,Object.values(sources.epochs),sources.epoch);}
      state.controls[control.requestId]={control,conversationId,taskIds:control.type==='abort'||control.type==='stop'?taskIds:[],submissionIds,status:control.type==='new'?'done':'pending'};
      return false;
    },context);
    if(rejected)throw busyControlError();
  }
  private async recoverControls(){
    const {harness,root}=this.runtime;
    const controls=(await harness.snapshot(HostState,root.id,context))?.controls??{};
    for(const [key,record] of Object.entries(controls)){
      if(record.status==='done'||record.status==='uncertain'||record.status==='rejected')continue;
      await this.config.controlPolicy(record.control);
      if(record.control.type==='compact'&&record.status==='executing'){
        await root.commit(async tx=>{(await tx.doc(HostState,root.id)).controls[key]!.status='uncertain';},context);continue;
      }
      await root.commit(async tx=>{(await tx.doc(HostState,root.id)).controls[key]!.status='executing';},context);
      // Withdrawal precedes active cancellation, preventing a queued item from starting.
      for(const id of record.submissionIds)await (await harness.submission(id,context))?.abort(context);
      const taskIds=new Set(record.taskIds);
      if(record.control.type==='stop'){
        // A captured queued input may have started before its abort reached the native line.
        const bindings=await harness.snapshot(Bindings,root.id,context);
        for(const id of Object.values(bindings?.epochs??{})){
          const live=await harness.snapshot(LiveDoc,id,context);
          if(live?.run?.inputs.some(id=>record.submissionIds.includes(id)))taskIds.add(live.run.taskId);
        }
      }
      for(const id of taskIds){await harness.abortTask(id,context);await harness.waitForTask(id,context);}
      if(record.control.type==='compact'&&record.conversationId!==null)await (await harness.conversation(record.conversationId,context))?.compact(undefined,context);
      await root.commit(async tx=>{(await tx.doc(HostState,root.id)).controls[key]!.status='done';},context);
    }
  }
  async control(control:HostControl){
    this.assertOpen();if(!control.requestId||!control.principal)throw new Error('Control identity required');await this.config.controlPolicy(control);
    const work=this.serialize(async()=>{this.assertOpen();if(!this.validated){await this.preflight();this.validated=true;}await this.prepareControl(control);await this.recoverControls();});
    return new Promise<void>((resolve,reject)=>{
      const timeout=setTimeout(()=>{const error=new Error('Control cancellation deadline exceeded');this.fatal(error);reject(error);},this.config.closeTimeoutMs??10_000);
      work.then(()=>{clearTimeout(timeout);resolve();},error=>{clearTimeout(timeout);reject(error);});
    });
  }
  /** Run trusted administrative changes on the same line as acceptance/rotation.
   * The caller validates its authenticated command binding and records identity. */
  administration<T>(operation:()=>Promise<T>):Promise<T> {
    this.assertOpen();
    return this.serialize(async()=>{this.assertOpen();return operation();});
  }
  /** Explicit administrative controls still require authenticated source metadata. */
  rotate(requestId:string,principal:string,target:Target){return this.control({type:'new',requestId,principal,target});}
  abort(requestId:string,principal:string,target:Target){return this.control({type:'abort',requestId,principal,target});}
  stop(requestId:string,principal:string,target:Target){return this.control({type:'stop',requestId,principal,target});}
  async inspect(){const recovery=await inspectRecovery(this.runtime);const state=await this.runtime.harness.snapshot(HostState,this.runtime.root.id,context);return {...recovery,compatibility:state?.compatibility,controls:Object.entries(state?.controls??{}).filter(([,record])=>record.status!=='done').map(([identity,record])=>({identity,...record}))};}
  close():Promise<void>{
    if(this.closingPromise)return this.closingPromise;
    this.closing=true;if(this.timer)clearInterval(this.timer);
    const cleanup=async()=>{await this.config.transport.stop();await this.line;await this.runtime.harness.close(context);this.runtime.store.release();};
    // Keep the OS writer lock on timeout; only verified native close releases it.
    this.closingPromise=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{this.failed=true;this.report(new Error('Host shutdown deadline exceeded'));reject(new Error('Host shutdown deadline exceeded'));},this.config.closeTimeoutMs??10_000);cleanup().then(()=>{clearTimeout(timer);resolve();},error=>{clearTimeout(timer);this.failed=true;this.report(error);reject(error);});});
    return this.closingPromise;
  }
}
