import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { context } from '../../src/durable/ingress.js';
import { createNativeExecutionEnvironment } from '../../src/durable/general-tools.js';
import { loadNativeConfig } from '../../src/durable/config.js';
import { cleanup, setup } from './parity-application-fixture.js';

let release:string;
beforeAll(async()=>{
 const cache=join(process.cwd(),'node_modules/.cache');await mkdir(cache,{recursive:true});
 release=await mkdtemp(join(cache,'schedules-app-'));
 await promisify(execFile)(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.native-build.json','--outDir',join(release,'dist')],{timeout:90_000});
 await cp(join(process.cwd(),'.pi'),join(release,'.pi'),{recursive:true});
},100_000);
afterAll(async()=>{if(release)await rm(release,{recursive:true,force:true});});
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();vi.unstubAllEnvs();});

async function execute(config:Parameters<typeof createNativeExecutionEnvironment>[0],command:string){
 const environment=createNativeExecutionEnvironment(config);let stdout='';
 try{const result=await environment.exec(command,{timeout:10,onOutput:chunk=>{stdout+=Buffer.from(chunk).toString('utf8');}},context);expect(result.ok).toBe(true);if(result.ok)expect(result.value.exitCode).toBe(0);return stdout.trim();}
 finally{await environment.cleanup(context);}
}
const send=(path:string,input:unknown)=>`printf '%s' '${JSON.stringify(input)}' | "${process.execPath}" --disable-warning=ExperimentalWarning "$PI_TELEGRAM_BRIDGE_RESOURCE_ROOT/${path}"`;

 test('schedule profile validates explicit selections and rejects additions to earlier profiles',async()=>{
  const s=await setup('durable-jobs-schedules-test');
  const {historyDir,inboxPath,runtimeMetadataPath,...raw}=s.config;
  const path=join(s.directory,'instance.json');
  const load=async(value:unknown)=>{await writeFile(path,JSON.stringify(value),{mode:0o600});return loadNativeConfig(path);};
  await expect(load(raw)).resolves.toMatchObject({jobsRole:'coordinator',coordinator:{schedules:{checkerIds:[]}}});
  const configure=(schedules:unknown)=>({...raw,coordinator:{...raw.coordinator,schedules}});
  for(const schedules of [undefined,{checkerIds:['unknown']},{checkerIds:['gmail-inbox','gmail-inbox']},{checkerIds:[],webhook:{port:0}},{checkerIds:[],webhook:{port:65536}},{checkerIds:[],webhook:{port:12345,host:'0.0.0.0'}},{checkerIds:[],extra:true}])await expect(load(configure(schedules))).rejects.toThrow();
  for(const capabilityProfile of ['durable-jobs-coordinator-test','durable-jobs-test','durable-parity-test'])await expect(load({...raw,capabilityProfile})).rejects.toThrow();
  const judgeKeyFile=join(s.directory,'judge-key');await writeFile(judgeKeyFile,'synthetic-key',{mode:0o600});
  await expect(load(configure({checkerIds:['gmail-inbox'],judgeKeyFile,webhook:{port:12345}}))).resolves.toMatchObject({coordinator:{schedules:{checkerIds:['gmail-inbox'],judgeKeyFile,webhook:{port:12345}}}});
  await chmod(judgeKeyFile,0o644);await expect(load(configure({checkerIds:[],judgeKeyFile}))).rejects.toThrow(/private owned/);
  await chmod(judgeKeyFile,0o600);const linked=join(s.directory,'judge-link');await symlink(judgeKeyFile,linked);await expect(load(configure({checkerIds:[],judgeKeyFile:linked}))).rejects.toThrow(/private owned/);
 });

 test('only schedule-enabled shells receive coordinator paths and no ambient manifest or judge key',async()=>{
  vi.stubEnv('PI_TELEGRAM_JOBS_DIR','/ambient/jobs');vi.stubEnv('PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST','/ambient/manifest');vi.stubEnv('PI_TELEGRAM_TYPESAFE_API_KEY_FILE','/ambient/key');
  for(const profile of ['durable-jobs-test','durable-jobs-coordinator-test','durable-jobs-schedules-test']){
   const s=await setup(profile);
   const command=`"${process.execPath}" -e 'console.log(JSON.stringify({jobs:process.env.PI_TELEGRAM_JOBS_DIR,root:process.env.PI_TELEGRAM_BRIDGE_STATE_ROOT,state:process.env.PI_TELEGRAM_BRIDGE_STATE_DIR,manifest:process.env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST,key:process.env.PI_TELEGRAM_TYPESAFE_API_KEY_FILE}))'`;
   const actual=JSON.parse(await execute(s.config,command));
   expect(actual).toEqual(profile==='durable-jobs-schedules-test'?{jobs:s.config.coordinator!.coordinatorStateDir,root:s.directory,state:s.config.stateDir}:{state:s.config.stateDir});
  }
 });

 test('compiled release helpers acknowledge scoped definitions and retire a temporary watch through the actual application',async()=>{
  const s=await setup('durable-jobs-schedules-test');s.config.coordinator!.schedules={checkerIds:['retail-product-price']};
  await s.open([],false,{coordinator:{nowMs:()=>Date.parse('2024-01-02T03:04:05Z'),tickIntervalMs:20}});
  const config={...s.config,resourceRoot:release};
  const helper='.pi/skills/schedule-reminders-and-jobs/scripts/jobs-cli.mjs';
  const added=JSON.parse(await execute(config,send(helper,{operation:'add_at',id:'future-reminder',target:'test',at:'2999-01-01T00:00:00Z',prompt:'Synthetic reminder'})));
  expect(added).toMatchObject({ok:true,stateDir:s.config.coordinator!.coordinatorStateDir,publication:{status:'accepted'}});
  const listed=JSON.parse(await execute(config,send(helper,{operation:'list'})));expect(listed.jobs.map((job:{id:string})=>job.id)).toEqual(['future-reminder']);
  const watch={source:{kind:'shopify',url:'https://shop.example.com/products/sample',id:'123',currency:'USD'},baselineCents:'5000',mode:'ratio',createdAt:'2024-01-02T03:04:05Z',endCondition:'Synthetic cancellation',baselineEvidence:'Synthetic verified regular price',job:{target:'test',schedule:'0,5 9 * * *',tz:'UTC',rule:{type:'condition',operator:'less-than',target:8001,for:'1s',notify:'once-per-episode'},onTrigger:{type:'prompt',prompt:'Verify the synthetic source before reporting'}}};
  expect(JSON.parse(await execute(config,send('dist/src/price-watches.js',{operation:'upsert',id:'sample-watch',watch})))).toMatchObject({ok:true,publication:{status:'accepted'}});
  const temporary=join(s.config.coordinator!.coordinatorStateDir,'temporary','price-watches');
  expect(JSON.parse(await readFile(join(temporary,'sample-watch','watch.json'),'utf8'))).toMatchObject({endCondition:watch.endCondition,baselineEvidence:watch.baselineEvidence});
  expect(JSON.parse(await execute(config,send('dist/src/price-watches.js',{operation:'retire',id:'sample-watch'})))).toMatchObject({ok:true,retired:true});
  expect(await readdir(join(temporary,'retired'))).toHaveLength(1);
  expect((await readdir(s.config.stateDir)).includes('jobs.json')).toBe(false);
  expect(s.requests).toEqual([]);expect(s.fatal).toEqual([]);
 });

 test('build emits every selected checker and both release helper entrypoints',async()=>{
  const modules=['jobs-cli','price-watches',...['web-page-items','retail-product-price','gmail-inbox','ynab-unapproved'].map(id=>'checkers/'+id)];
  for(const module of modules)expect(await readFile(join(release,'dist','src',module+'.js'),'utf8')).toBeTruthy();
  await promisify(execFile)(process.execPath,['--input-type=module','-e',`await Promise.all(${JSON.stringify(modules.map(module=>join(release,'dist','src',module+'.js')))}.map(path=>import(path)))`],{timeout:10_000});
 });

 test('recipient shell delegates through compiled helper without coordinator paths or ambient authority',async()=>{
  const coordinator=await setup('durable-jobs-schedules-test');
  const keyFile=join(coordinator.directory,'schedule-client.key');await writeFile(keyFile,'a'.repeat(64),{mode:0o600});
  const socketPath=join(coordinator.directory,'schedule.sock');
  coordinator.config.coordinator!.control={socketPath,grants:[{keyFile,jobPrefix:'delegated-',targets:['test']}]};
  await coordinator.open([],false,{coordinator:{tickIntervalMs:20}});
  const recipient=await setup('durable-jobs-test');recipient.config.scheduleClient={socketPath,keyFile,serverUid:process.getuid!()};
  const {historyDir,inboxPath,runtimeMetadataPath,...raw}=recipient.config;
  const configPath=join(recipient.directory,'config.json');await writeFile(configPath,JSON.stringify(raw),{mode:0o600});
  expect((await loadNativeConfig(configPath)).scheduleClient).toEqual(recipient.config.scheduleClient);
  const config={...recipient.config,resourceRoot:release};
  vi.stubEnv('PI_TELEGRAM_JOBS_DIR','/untrusted');vi.stubEnv('PI_TELEGRAM_SCHEDULE_CLIENT','/untrusted');
  const actual=JSON.parse(await execute(config,`"${process.execPath}" -e 'console.log(JSON.stringify({client:process.env.PI_TELEGRAM_SCHEDULE_CLIENT,jobs:process.env.PI_TELEGRAM_JOBS_DIR,manifest:process.env.PI_TELEGRAM_BRIDGE_INSTANCE_MANIFEST}))'`));
  expect(actual).toEqual({client:JSON.stringify(config.scheduleClient)});
  const helper='.pi/skills/schedule-reminders-and-jobs/scripts/jobs-cli.mjs';
  const result=JSON.parse(await execute(config,send(helper,{operation:'add_at',id:'delegated-check',target:'test',at:'2999-01-01T00:00:00Z',prompt:'Synthetic check',expectedRevision:null})));
  expect(result).toMatchObject({ok:true,publication:{status:'accepted'}});expect(result).not.toHaveProperty('stateDir');
  const listing=JSON.parse(await execute(config,send(helper,{operation:'list'})));
  expect(listing.jobs[0]).toMatchObject({job:{id:'delegated-check'},revision:result.revision});
  expect(JSON.parse(await execute(config,send(helper,{operation:'inspect_handoffs'})))).toMatchObject({ok:true});
  const {scheduleClient,...withoutClient}=config;
  expect(await execute(withoutClient,'printf "%s" "${PI_TELEGRAM_SCHEDULE_CLIENT-unset}"')).toBe('unset');
  await writeFile(configPath,JSON.stringify({...raw,scheduleClient:{...raw.scheduleClient,serverUid:-1}}));
  await expect(loadNativeConfig(configPath)).rejects.toThrow(/schedule client/);
  await writeFile(configPath,JSON.stringify({...raw,jobsRole:'coordinator',scheduleClient:raw.scheduleClient}));
  await expect(loadNativeConfig(configPath)).rejects.toThrow();
 });
