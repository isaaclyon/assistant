import { basename, matchesGlob } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolExecutionApi, type ToolRegistration } from '@earendil-works/pi-durable';
import { getOrThrow } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import type { Context } from '@earendil-works/chord/context';
import type { NativeConfig } from './config.js';
import { textToolResult, type NativeBundle } from './registry.js';

const MAX_BYTES=50*1024;
const MAX_TIMEOUT=300;
/** Shells inherit ordinary user paths/locale, not the bridge's ambient credentials
 * or operational flags. OS identity remains the filesystem/process boundary. */
export function createNativeExecutionEnvironment(config:NativeConfig) {
 const shellEnv:Record<string,string>={};
 for(const key of ['PATH','HOME','USER','LOGNAME','SHELL','LANG','LC_ALL','LC_CTYPE','TERM','TMPDIR','TMP','TEMP','TZ']) {
  if(process.env[key]!==undefined)shellEnv[key]=process.env[key];
 }
 Object.assign(shellEnv,{
  PI_TELEGRAM_BRIDGE_RESOURCE_ROOT:config.resourceRoot,
  PI_TELEGRAM_BRIDGE_STATE_DIR:config.stateDir,
  PI_TELEGRAM_BRIDGE_INSTANCE_ID:config.instanceId,
  PI_TELEGRAM_PRINCIPAL:config.principal,
 });
 const env=new NodeExecutionEnv({cwd:config.workspaceCwd});
 const execute=env.exec.bind(env);
 // SDK shellEnv overlays process.env; inheritEnv:false is required to exclude it.
 env.exec=(command,options,context)=>execute(command,{...options,inheritEnv:false,env:{...shellEnv,...options?.env}},context);
 return env;
}
function environment(api:ToolExecutionApi) {
 if(!api.env)throw new Error('Selected tool execution environment is unavailable');
 return api.env;
}
/** Fixed argv prevents paths, patterns and glob syntax from becoming shell code.
 * Inspection is bounded independently of model-supplied result limits. */
async function inspectCommand(argv:string[],cwd:string,limit:number,api:ToolExecutionApi,context:Context,format:(line:string)=>string|undefined=line=>line) {
 const chunks:Buffer[]=[];let bytes=0,truncated=false;
 const result=await environment(api).exec(argv,{cwd,timeout:10,inheritEnv:false,onOutput:chunk=>{
  const data=Buffer.from(chunk);const retained=data.subarray(0,Math.max(0,MAX_BYTES-bytes));
  if(retained.length){chunks.push(retained);bytes+=retained.length;}
  if(retained.length<data.length)truncated=true;
 }},context);
 if(!result.ok)throw new Error(result.error.code==='spawn_error'?'Repository inspection requires ripgrep (rg) on PATH':`Inspection failed (${result.error.code})`);
 const raw=Buffer.concat(chunks).toString('utf8');
 // A byte-limited capture can end halfway through a path or JSON event.
 const complete=truncated?raw.slice(0,raw.lastIndexOf('\n')+1):raw;
 if(result.value.exitCode!==0&&result.value.exitCode!==1)return textToolResult(complete.trimEnd()||'Inspection command failed',true);
 const lines=complete.trimEnd().split('\n').filter(Boolean).map(format).filter((line):line is string=>line!==undefined);
 truncated ||= lines.length>limit;
 return textToolResult((lines.slice(0,limit).join('\n')||(truncated?'No matches in retained output.':'No matches found.'))+(truncated?'\n[Inspection incomplete: output cap reached; additional matching files or lines may exist.]':''));
}
function validateGlob(pattern:string) {
 // Keep synchronous matching small and exclude combinatorial brace/extglob expansion.
 if(pattern.length>256||/[{}()]/.test(pattern)||(pattern.match(/\*/g)?.length??0)>8)throw new Error('Use a simple glob up to 256 characters and 8 stars, without braces or parentheses');
 return pattern;
}
function globMatches(path:string,pattern:string) {
 const normalized=path.replace(/^\.\//,'');
 return matchesGlob(normalized,pattern)||(!pattern.includes('/')&&matchesGlob(basename(normalized),pattern));
}
function grepLine(line:string,glob?:string) {
 const event=JSON.parse(line);
 if(event.type!=='match'&&event.type!=='context')return undefined;
 const decode=(value:{text?:string;bytes?:string})=>value.text??Buffer.from(value.bytes??'','base64').toString('utf8');
 const path=decode(event.data.path);
 if(glob!==undefined&&!globMatches(path,glob))return undefined;
 const content=decode(event.data.lines).trimEnd();
 return `${path}:${event.data.line_number}:${content.slice(0,500)}${content.length>500?' [Line truncated.]':''}`;
}
function inspectionTools():ToolRegistration[] {
 const common={replay:'safe' as const,outputLimits:{maxBytes:MAX_BYTES,maxLines:2000}};
 return [
  defineTool({...common,name:'grep',description:'Search file contents with ripgrep. Optional glob uses simple *, **, ? and character classes (no braces/parentheses, at most 8 stars). Respects gitignore, returns paths and line numbers, and bounds matches to 100 by default (maximum 1000).',parameters:Type.Object({
   pattern:Type.String({minLength:1,maxLength:10000}),path:Type.Optional(Type.String({maxLength:4096})),glob:Type.Optional(Type.String({maxLength:256})),ignoreCase:Type.Optional(Type.Boolean()),literal:Type.Optional(Type.Boolean()),context:Type.Optional(Type.Integer({minimum:0,maximum:20})),limit:Type.Optional(Type.Integer({minimum:1,maximum:1000})),
  }),execute:async(args,api,ctx)=>{
   if(args.glob!==undefined)validateGlob(args.glob);
   const argv=['rg','--json','--color','never'];
   if(args.ignoreCase)argv.push('--ignore-case');if(args.literal)argv.push('--fixed-strings');if(args.context)argv.push('--context',String(args.context));
   argv.push('--',args.pattern,args.path??'.');
   return inspectCommand(argv,environment(api).cwd,args.limit??100,api,ctx,line=>grepLine(line,args.glob));
  }}),
  defineTool({...common,name:'find',description:'Find files matching a simple glob (*, **, ?, character classes; no braces/parentheses; at most 8 stars), respecting gitignore. Returns at most 1000 paths and 50KB.',parameters:Type.Object({pattern:Type.String({minLength:1,maxLength:256}),path:Type.Optional(Type.String({maxLength:4096})),limit:Type.Optional(Type.Integer({minimum:1,maximum:1000}))}),execute:async(args,api,ctx)=>{
   validateGlob(args.pattern);
   const env=environment(api),cwd=getOrThrow(await env.absolutePath(args.path??'.',ctx));
   // Positive rg --glob rules override gitignore. Filter only after rg applies its ignore rules.
   return inspectCommand(['rg','--files','--color','never','--','.'],cwd,args.limit??1000,api,ctx,line=>globMatches(line,args.pattern)?line:undefined);
  }}),
  defineTool({...common,name:'ls',description:'List directory entries, including dotfiles, sorted by name with / after directories. Returns up to 500 entries; large directories return a sorted bounded sample.',parameters:Type.Object({path:Type.Optional(Type.String({maxLength:4096})),limit:Type.Optional(Type.Integer({minimum:1,maximum:500}))}),execute:async(args,api,ctx)=>{
   const env=environment(api),path=getOrThrow(await env.absolutePath(args.path??'.',ctx));
   const reader=getOrThrow(await env.openDirReader(path,ctx));
   try {
    const limit=args.limit??500,page=getOrThrow(await reader.next(limit+1,ctx));
    const entries=page.entries.slice(0,limit).map(item=>item.name+(item.kind==='directory'?'/':'')).sort();
    return textToolResult((entries.join('\n')||'(empty directory)')+(!page.done||page.entries.length>limit?'\n[Output truncated.]':''));
   } finally {await reader.close(ctx);}
  }}),
 ];
}
export function createGeneralToolsBundle():NativeBundle {
 const bash=createBashTool();
 const boundedBash:ToolRegistration={...bash,replay:'unsafe',executionMode:'sequential',description:bash.description+' Commands default to 60 seconds and cannot exceed 300 seconds. An interrupted command is not replayed; inspect its effects before retrying.',parameters:Type.Object({command:Type.String({minLength:1}),timeout:Type.Optional(Type.Number({exclusiveMinimum:0,maximum:MAX_TIMEOUT}))}),execute:async(args,api,ctx)=>{
  const input=args as {command:string;timeout?:number};
  const timeout=input.timeout??60;
  if(!Number.isFinite(timeout)||timeout<=0||timeout>MAX_TIMEOUT)throw new Error('Shell timeout must be greater than zero and at most 300 seconds');
  return bash.execute({...input,timeout},api,ctx);
 }};
 return {name:'general-tools',version:1,tools:[
  {version:1,tool:{...createReadTool(),replay:'safe'}},
  {version:1,tool:{...createWriteTool(),replay:'unsafe',executionMode:'sequential'}},
  {version:1,tool:{...createEditTool(),replay:'unsafe',executionMode:'sequential'}},
  {version:1,tool:boundedBash},
  ...inspectionTools().map(tool=>({version:1,tool})),
 ],close:async()=>{}};
}
