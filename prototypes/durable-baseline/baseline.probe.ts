import { mkdtemp, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { MemoryApplication } from "../../src/memory-application.js";
import { compileCoreMemory } from "../../.pi/skills/personal-memory/scripts/inspect.mjs";
import { recallMemories } from "../../src/memory-recall.js";
import { openInbox } from "../../src/inbox.js";
import { openSearchIndex } from "../../src/search-index.js";
import { rebuildMemoryIndex, searchIndexedMemories } from "../../src/search-coordinator.js";
import { prepareHost } from "./host-fixture.js";

it("records a synthetic offline C0 baseline to an explicit external file", async () => {
  const output = process.env.DURABLE_BASELINE_OUTPUT;
  if (!output || !isAbsolute(output)) throw new Error("DURABLE_BASELINE_OUTPUT must be an absolute external filename");
  const repository = await realpath(process.cwd());
  const outputParent = await realpath(dirname(output)); // caller creates private directory
  if (relative(repository, outputParent).split("/")[0] !== "..") throw new Error("Evidence must be outside repository");
  const root = await mkdtemp(join(tmpdir(), "durable-baseline-"));
  const prior = {...process.env};
  const samples: Record<string, number[]> = {};
  const growth: Array<Record<string, number | string>> = [];
  const timed = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const start = performance.now(); const result = await fn();
    (samples[name] ??= []).push(performance.now()-start); return result;
  };
  const bytes = async (path: string): Promise<number> => {
    let total = 0;
    for (const entry of await readdir(path, {withFileTypes:true})) {
      const child = join(path,entry.name);
      total += entry.isDirectory() ? await bytes(child) : (await stat(child)).size;
    }
    return total;
  };
  vi.stubGlobal("fetch", vi.fn(async () => {throw new Error("Probe forbids network fetch");}));
  try {
    // Empty-profile hosts still load the host's standard pinned provider/web extensions.
    for (let sample=0; sample<10; sample++) {
      const hostRoot = join(root, `host-${sample}`);
      const start = await prepareHost(hostRoot);
      const host = await timed("host_start_to_return_module_cache_warm", start);
      try {
        const session = host.runtime.session;
        expect(session.isIdle).toBe(true);
        session.agent.streamFunction = () => {
          const stream = createAssistantMessageEventStream();
          const message: AssistantMessage = {role:"assistant",content:[{type:"text",text:"SYNTHETIC_FINAL"}],
            api:"openai-codex-responses",provider:"openai-codex",model:"gpt-6-luna",stopReason:"stop",timestamp:1784160001000,
            usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
          stream.push({type:"done",reason:"stop",message}); return stream;
        };
        const before = await bytes(hostRoot);
        await timed("ordinary_turn_fake_provider", async () => {
          await session.prompt("[telegram] Synthetic baseline question", {source:"rpc"});
          await session.waitForIdle();
        });
        expect(session.getLastAssistantText()).toBe("SYNTHETIC_FINAL");
        growth.push({phase:"one_host_turn_open",sample,before,after:await bytes(hostRoot)});
      } finally { await host.dispose(); }
    }
    const vault = join(root,"vault"), state = join(root,"memory-state");
    const env = {PI_TELEGRAM_MEMORY_DIR:vault,PI_TELEGRAM_BRIDGE_STATE_DIR:state,
      PI_TELEGRAM_PRINCIPAL:"isaac",PI_TELEGRAM_MEMORY_VIEW:"owner-and-household"};
    const app = new MemoryApplication({env,findDuplicates:async()=>({results:[],truncated:false})});
    const index = openSearchIndex({stateDir:state});
    try {
      // Fixed 20-note corpus; a fresh create/read/update/delete note in each iteration.
      for (let i=0;i<20;i++) {
        const draft = await app.prepareCreate({type:"preference",title:`Synthetic coffee ${i}`,body:`Prefers coffee number ${i}. ${i===0?"#core":""}`});
        await app.create(draft.creationToken);
      }
      await rebuildMemoryIndex({index,vaultRoot:vault,resourceRoot:repository});
      const before = await bytes(vault);
      for (let i=0;i<10;i++) {
        const note = await timed("memory_create_fake_duplicate_lookup",async()=>{
          const draft = await app.prepareCreate({type:"preference",title:`Transient ${i}`,body:"Synthetic tea preference."});
          return app.create(draft.creationToken);
        });
        const id = String(note.id);
        await timed("memory_read",()=>app.read(id));
        const updated = await timed("memory_update",()=>app.update(id,String(note.revision),{append:"Additional synthetic detail."}));
        expect(updated.body).toContain("Additional synthetic detail.");
        await timed("memory_delete_with_synthetic_confirmation",async()=>{
          const pending = await app.requestConfirmation("delete",id,String(updated.revision));
          app.bindConfirmation(pending.token,1);
          expect(await app.confirm(pending.token,1)).toMatchObject({deleted:true});
        });
        await timed("core_compile_20_notes",async()=>{
          const core = await compileCoreMemory({root:vault,principal:"isaac",memoryView:"owner-and-household"});
          expect(core.text).toContain("coffee number 0");
        });
        await timed("memory_fts_search_20_notes",()=>{
          expect(searchIndexedMemories(index,{query:"coffee",principal:"isaac",memoryView:"owner-and-household",limit:10}).results.length).toBeGreaterThan(0);
        });
        const recalled = await timed("recall_prepare_fake_retrieval_judge_revision_log",()=>recallMemories({prompt:"[telegram] What coffee should I buy?",entries:[],sessionId:"synthetic"},{
          retrieve:async()=>[{id:"synthetic",revision:"r1",type:"preference",title:"Coffee",snippet:"Prefers coffee."}],
          currentRevisions:async()=>new Map([["synthetic","r1"]]),
          judge:async(request)=>({model:"synthetic",probabilities:Object.fromEntries(Object.keys(request.questions).map(key=>[key,key.startsWith("n")?0.9:0]))}),
          log:async()=>{},
        }));
        expect(recalled).toBeDefined();
      }
      growth.push({phase:"vault_20_notes_plus_10_crud_cycles",before,after:await bytes(vault)});
    } finally { index.close(); }
    for(let sample=0;sample<10;sample++) {
      const path=join(root,`inbox-${sample}.db`);
      let inbox=openInbox(path);
      const before=(await stat(path)).size;
      for(let i=0;i<100;i++) inbox.persist(`synthetic:${i}`,JSON.stringify({text:"Synthetic replay payload",index:i}),i);
      inbox.close();
      await timed("inbox_reopen_load_remove_100",()=>{
        inbox=openInbox(path);
        try {
          const pending=inbox.loadPending(); expect(pending).toHaveLength(100);
          expect(pending[0]?.id).toBe("synthetic:0");
          for(const row of pending) inbox.remove(row.id);
          expect(inbox.loadPending()).toEqual([]);
        } finally { inbox.close(); }
      });
      growth.push({phase:"inbox_100_enqueue_reopen_remove_closed",sample,before,after:(await stat(path)).size});
    }
    const distributions = Object.fromEntries(Object.entries(samples).map(([name, values])=>{
      const sorted=[...values].sort((a,b)=>a-b);
      const percentile=(p:number)=>sorted[Math.ceil(sorted.length*p)-1];
      return [name,{unit:"ms",samples:values,count:values.length,min:sorted[0],p50:percentile(.5),p95:percentile(.95),max:sorted.at(-1)}];
    }));
    await writeFile(output,JSON.stringify({schema:1,kind:"prototype-only fake-provider/no-network",recordedAt:new Date().toISOString(),node:process.version,platform:process.platform,arch:process.arch,distributions,growth},null,2)+"\n",{flag:"wx",mode:0o600});
  } finally {
    vi.unstubAllGlobals();
    for(const key of Object.keys(process.env)) if(!(key in prior)) delete process.env[key];
    Object.assign(process.env,prior);
    await rm(root,{recursive:true,force:true});
  }
});
