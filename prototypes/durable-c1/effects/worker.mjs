import { open, enqueue, prepareApproval, context } from './runtime.mjs';
if(process.argv[3]==='approval') {
 const app=await open(process.argv[2]);
 await prepareApproval(app);
 await app.close();
 process.disconnect?.();
} else {
 const app=await open(process.argv[2],{killPoint:true,missingReceipt:process.argv[3]==='missing'});
 await app.root.commit(tx=>enqueue(tx,app.root.id),context);
 app.harness.resume();
 // Keep the crash barrier alive until the test supervisor kills us.
 setInterval(()=>{},1000);
}
