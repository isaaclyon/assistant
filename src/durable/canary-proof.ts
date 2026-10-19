import { Bindings, context, fingerprint, sourceKey, type IngressRuntime } from './ingress.js';
import { JobAdmissions } from './job-admission.js';
import { MediaOutbox } from './media-outbound.js';
import { inspectRecovery } from './recovery.js';

/** Native completion evidence, independent of the v1 handoff directory name.
 * Run only while the selected writer is stopped. Snapshot/lookup never submits,
 * resumes, waits for a task, or invokes a remote provider. */
export async function inspectScheduledCompletion(runtime:IngressRuntime,dispatchId:string) {
 if(!/^[a-z0-9-]{1,64}-[a-f0-9]{16}(?:[a-f0-9]{48})?$/.test(dispatchId))throw new Error('Invalid canary dispatch identity');
 const receipt=(await runtime.harness.snapshot(JobAdmissions,runtime.root.id,context))?.receipts[dispatchId];
 if(!receipt||receipt.admission!=='admitted'||receipt.run!=='done'||!receipt.cid||!receipt.submissionId)throw new Error('Canary scheduled work has no completed native admission');
 const binding=(await runtime.harness.snapshot(Bindings,runtime.root.id,context))?.sources[receipt.sourceKey];
 if(!binding||binding.envelope.job?.dispatchId!==dispatchId||binding.envelope.proactive!==true||binding.envelope.messageIds.length!==0||sourceKey(binding.envelope)!==receipt.sourceKey||fingerprint(binding.envelope)!==receipt.fingerprint||binding.fingerprint!==receipt.fingerprint||binding.conversationId!==receipt.cid||binding.submissionId!==receipt.submissionId)throw new Error('Canary scheduled source binding differs from its receipt');
 const submission=await runtime.root.commit(tx=>tx.submissionByRequest(receipt.cid!,receipt.requestId),context);
 if(!submission||submission.type!=='input'||submission.id!==receipt.submissionId||submission.status!=='done')throw new Error('Canary scheduled native submission is not done');
 const outbox=await runtime.harness.snapshot(MediaOutbox,runtime.root.id,context);
 if(Object.values(outbox?.items??{}).some(group=>group.files.some(file=>file.status==='queued'||file.status==='sending'||file.status==='uncertain'||file.notice==='sending'||file.notice==='unknown')))throw new Error('Canary recovery contains unfinished or uncertain media delivery');
 const recovery=await inspectRecovery(runtime);
 if(recovery.uncertain.length||recovery.inspection.tasks.some(task=>task.state.kind==='blocked'))throw new Error('Canary recovery contains uncertain delivery or blocked tasks');
 return {version:1 as const,instanceId:binding.envelope.instance,dispatchId,submissionId:receipt.submissionId,outcome:'done' as const,createdAt:Date.parse(binding.envelope.job.createdAt),inspectedAt:Date.now()};
}
