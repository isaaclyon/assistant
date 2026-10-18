import { StringEnum, Type } from '@earendil-works/pi-ai';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { NativeConfig } from './config.js';
import { nativeGoogleRuntime } from './google-read.js';
import { textToolResult, type NativeBundle } from './registry.js';
import { runPrivateBrowserInput } from '../private-browser-input.js';
import { runBrowserTakeover } from '../browser-takeover.js';
import { openTableRequest } from '../opentable-private-flow.js';
import { validateProtectedRequest, type ProtectedInputRequest } from '../protected-browser.js';
import { validateTakeoverRequest, type TakeoverRequest } from '../browser-takeover-protection.js';
import { validatePrivateLoginRequest, type PrivateLoginRequest } from '../private-login.js';
import type { PrivateBrowserConfig } from '../private-browser-config.js';
import { readDemoTelegramProfile } from '../secure-input-demo-launch.js';
import { runtimeTelegramFetch } from '../runtime-telegram-transport.js';

export interface NativeBrowserServices {
 input:typeof runPrivateBrowserInput;
 takeover:typeof runBrowserTakeover;
 candidates?:(origin:string,signal:AbortSignal)=>Promise<unknown>;
}
const unavailable=()=>textToolResult({status:'unavailable'});
const terminal=new Set(['submitted','handed_back','cancelled','expired','failed','unavailable','browser_blocked']);
/** Whitelist at the native boundary: no future domain response can accidentally
 * add page, mail, protocol or credential data to durable tool output. */
export function browserOutcome(raw:unknown):Record<string,string> {
 if(!raw||typeof raw!=='object')return {status:'unavailable'};
 const value=raw as Record<string,unknown>;
 if(typeof value.status!=='string'||!terminal.has(value.status))return {status:'unavailable'};
 return {status:value.status,...(value.mode==='private'||value.mode==='share'?{mode:value.mode}:{}),
  ...(typeof value.copiedCredentialItem==='string'&&/^[a-z0-9]{26}$/.test(value.copiedCredentialItem)?{copiedCredentialItem:value.copiedCredentialItem}:{}),
  ...(value.credentialCopyStatus==='unknown'?{credentialCopyStatus:'unknown'}:{})};
}
async function findCandidates(origin:string,signal:AbortSignal):Promise<unknown>{
 const response=await runtimeTelegramFetch('https://api.telegram.org/bot0:surrogate/credentialCandidates',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({origin}),signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),
 });
 if(!response.ok)throw new Error('Saved logins unavailable');return response.json();
}
export function createNativeBrowser(config:NativeConfig,services:NativeBrowserServices={input:runPrivateBrowserInput,takeover:runBrowserTakeover}) {
 if(!['durable-browser-test','durable-provider-test','durable-parity-test','durable-jobs-test'].includes(config.capabilityProfile)||config.principal!=='isaac'||!config.browser||!config.google)throw new Error('Native browser selection is unavailable');
 const selected=config.browser;
 const domain:PrivateBrowserConfig={instanceId:config.instanceId,executionInstanceId:config.instanceId,telegramSurface:{type:'private'},agentDir:selected.agentDir,
  telegramProfile:selected.telegramProfile,resourceRoot:config.resourceRoot,credentialScope:selected.credentialScope,emailCodeEnabled:true,googleRuntime:nativeGoogleRuntime(config)};
 let closed=false;
 const active=new Set<AbortController>(),pending=new Set<Promise<unknown>>();
 async function identity(){
  const profile=await readDemoTelegramProfile(selected.agentDir,selected.telegramProfile);
  if(profile.userId!==config.transport.allowedUserId||!profile.botToken.startsWith(`${config.transport.botId}:`)||
   (config.transport.mode==='broker'&&profile.botToken!==`${config.transport.botId}:runtime`))throw new Error('Browser Telegram identity differs');
 }
 async function execute(request:ProtectedInputRequest|TakeoverRequest|PrivateLoginRequest,ctx:Context){
  if(closed||active.size)return unavailable();
  const controller=new AbortController();active.add(controller);
  const signal=AbortSignal.any([controller.signal,...(ctx.abortSignal?[ctx.abortSignal]:[]),AbortSignal.timeout(600_000)]);
  const work=(async()=>{
   try{
    await identity();if(signal.aborted||closed)return unavailable();
    if('fields' in request)validateProtectedRequest(request);
    else if('pageUrl' in request)validatePrivateLoginRequest(request);
    else validateTakeoverRequest(request);
    const common={config:domain,chatId:config.transport.allowedUserId,signal,notifyWaiting:()=>{}};
    const result='fields' in request?await services.input({...common,request}):await services.takeover({...common,request,...('pageUrl' in request?{login:request}:{})});
    return textToolResult(browserOutcome(result));
   }catch{return unavailable();}
  })();pending.add(work);
  try{return await work;}finally{pending.delete(work);active.delete(controller);}
 }
 const wrap=(tool:ToolRegistration)=>({version:1,tool:{...tool,replay:'unsafe' as const,executionMode:'sequential' as const,outputLimits:{maxBytes:8192,maxLines:100}}});
 const tools:NativeBundle['tools']=[];
 const register=(tool:ToolRegistration)=>(tools as Array<ReturnType<typeof wrap>>).push(wrap(tool));
 const specprivate_browser_login={
    name: "private_browser_login",
    description: "Private multi-step existing-account sign-in in stock Chrome. Recognizes common same-origin POST email/username, password and verification-code screens, retaining the protected browser across steps. The Mini App can switch directly to human takeover for unfamiliar screens. Returns only a fixed terminal status and reopens the clean resume URL unless the user explicitly shares a page.",
    promptGuidelines: [
      "Use private_browser_login for authorized existing-account sign-in across multiple screens. Inspect the initial page first; pass its exact pageUrl and a clean same-origin HTTPS resumeUrl. Tell the user to keep Tailscale connected and open Sign in privately.",
      "Never ask for credentials in chat or tool arguments. Optional credentialItem names a user-approved Login item in the current instance's dedicated 1Password vault; the user may select Use saved sign-in privately. When find_login_candidates is available, a source: reference plus purpose requests Allow Once, Always Allow or Deny through trusted Telegram buttons before protected sign-in. Resolve ambiguous candidates before requesting approval. No general email-code lookup is enabled; codes remain private manual input.",
      "copiedCredentialItem reports an independent saved copy even if browser sign-in fails. Report the copy and sign-in outcomes separately. Removing that copy stops future password use but does not end existing website sessions.",
      "Stay paused for the whole operation. Do not inspect browser/runtime/profile files, use raw CDP, or run other browser tools while waiting. Unknown, repeated, embedded, cross-origin, recovery, registration or CAPTCHA screens need the Take over choice inside the Mini App; it preserves the same protected session.",
      "submitted is not proof of authentication. Verify the clean resume page afterward. Continue from this page explicitly shares the current website/form contents. On browser_blocked stop the stock session before reopening; never delete the gate.",
    ],
    parameters: Type.Object({ session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }), pageUrl: Type.String({ maxLength: 2000 }), resumeUrl: Type.String({ maxLength: 2000 }), credentialItem: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), purpose: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })) }, { additionalProperties: false }),
 };
 register(defineTool({...specprivate_browser_login,description:specprivate_browser_login.description+"\n"+specprivate_browser_login.promptGuidelines.join("\n"),execute:async(args,_api,ctx)=>execute(args,ctx)}));
 const specbrowser_takeover={
    name: "browser_takeover",
    description: "Let the paired user control a live stock-Chrome window inside a private Telegram Mini App. Pauses agent browser access until Hand back, cancellation or expiry. Requires one HTTPS tab and a clean same-origin resume URL. Only a fixed status returns; never browser images, keys or credentials.",
    promptGuidelines: [
      "Use browser_takeover for an authorized human-only browser step or when the user requests control. Tell them to keep Tailscale connected, tap Take over, and tap Hand back when finished. Wait for the tool result; do not run other tools or inspect the protected browser/runtime/profile.",
      "Provide a clean HTTPS resumeUrl on the current site's origin without query or fragment. Return privately reopens it and discards tabs/unsaved page state while retaining cookies. Continue from this page is an explicit user choice that shares the visible website, including form contents; it preserves in-page state. Verify the resulting page afterward.",
      "The human makes any consequential changes directly. A takeover does not authorize the assistant to make additional purchases, account changes or payments. Passkeys still need a compatible authenticator in that browser; takeover alone does not install or unlock 1Password.",
      "If browser_blocked is returned, stop that session with the stock helper before reopening. Never delete the crash gate or bypass it with raw CDP. On cancelled or expired results, private cleanup reopens resumeUrl; do not infer that the user's task succeeded.",
    ],
    parameters: Type.Object({ session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }), resumeUrl: Type.String({ maxLength: 2000 }) }, { additionalProperties: false }),
 };
 register(defineTool({...specbrowser_takeover,description:specbrowser_takeover.description+"\n"+specbrowser_takeover.promptGuidelines.join("\n"),execute:async(args,_api,ctx)=>execute(args,ctx)}));
 const specprivate_browser_input={
    name: "private_browser_input",
    description: "Open an authenticated Telegram form to fill and submit a supported website sign-in form. Values bypass model context. Waits for the user, then resumes this turn. Requires a private Telegram chat, one stock-Chrome tab, HTTPS, and a same-origin POST form. Closes the sensitive tab and opens resumeUrl afterward; verify sign-in separately.",
    promptGuidelines: [
      "Use only for user-authorized sign-in or verification, never purchases, account changes, or payments. Never ask for values in chat or tool parameters.",
      "Inspect the form first. Provide CSS selectors, exact pageUrl and a same-origin resumeUrl without query/fragment. Tell the user you will wait while they fill the Telegram form.",
      "Do not run parallel browser work, bypass the stock-Chrome gate, inspect browser runtime/profile files, or call raw CDP. If browser_blocked, stop that browser with the stock helper before reopening it.",
      "The generic private_browser_input supports ordinary same-origin POST forms. Use private_opentable_login for OpenTable's embedded email login. Use browser_takeover for authorized manual steps in other forms, frames or CAPTCHA; passkeys still require a compatible authenticator in that browser. SSH handoff remains a fallback.",
    ],
    parameters: Type.Object({
      session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }),
      pageUrl: Type.String({ maxLength: 2000 }), resumeUrl: Type.String({ maxLength: 2000 }),
      fields: Type.Array(Type.Object({ kind: StringEnum(["username", "password", "code"] as const), selector: Type.String({ minLength: 1, maxLength: 300 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
      submitSelector: Type.String({ minLength: 1, maxLength: 300 }),
    }, { additionalProperties: false }),
 };
 register(defineTool({...specprivate_browser_input,description:specprivate_browser_input.description+"\n"+specprivate_browser_input.promptGuidelines.join("\n"),execute:async(args,_api,ctx)=>execute(args,ctx)}));
 const specprivate_opentable_login={
    name: "private_opentable_login",
    description: "Sign in to an existing OpenTable account through a private Telegram form. Handles email, then password or a six-digit code inside the embedded sign-in page. Keeps the browser protected across steps and returns only a terminal status. Requires one stock-Chrome tab at https://www.opentable.com/ with Sign in open and Use email instead selected. Verify login afterward on the clean homepage.",
    promptGuidelines: [
      "Use private_opentable_login for user-authorized OpenTable sign-in. Open its homepage, click Sign in, and select Use email instead before calling. Do not ask for email, password or code in chat.",
      "Tell the user to keep Tailscale connected and fill the Telegram form; it asks for each step while you wait. Do not inspect the browser during entry. Registration, account changes, CAPTCHA and unexpected steps stop the flow and need manual handoff.",
      "In Gmail-enabled profiles, a fresh matching email code can be retrieved and filled privately when the receiving address matches the configured default inbox. Uncertain or unavailable lookup leaves manual input. Do not read an email thread into model context just to retrieve a code for this flow.",
    ],
    parameters: Type.Object({ session: Type.String({ pattern: "^[a-z0-9][a-z0-9._-]{0,62}$" }) }, { additionalProperties: false }),
 };
 register(defineTool({...specprivate_opentable_login,description:specprivate_opentable_login.description+"\n"+specprivate_opentable_login.promptGuidelines.join("\n"),execute:async(args,_api,ctx)=>execute(openTableRequest(args.session),ctx)}));
 if(config.transport.mode==='broker')register(defineTool({name:'find_login_candidates',description:'List only nonsecret Login titles and source references for an exact HTTPS origin from the configured trusted broker. Resolve ambiguous choices with the user. This grants no credential approval and copies nothing.',parameters:Type.Object({origin:Type.String({minLength:1,maxLength:1000})},{additionalProperties:false}),replay:'unsafe',execute:async(args,_api,ctx)=>{
  if(closed)return unavailable();
  const controller=new AbortController();active.add(controller);
  const work=(async()=>{try{
   const url=new URL(args.origin);if(url.protocol!=='https:'||url.origin!==args.origin||url.username||url.password)throw new Error();
   await identity();
   const raw=await (services.candidates??findCandidates)(args.origin,AbortSignal.any([controller.signal,...(ctx.abortSignal?[ctx.abortSignal]:[]),AbortSignal.timeout(30_000)]));
   const data=raw as {ok?:unknown;candidates?:unknown};
   if(data?.ok!==true||!Array.isArray(data.candidates)||data.candidates.length>50)throw new Error();
   const candidates=data.candidates.map(row=>{if(!row||typeof row!=='object'||typeof row.reference!=='string'||!/^source:[a-z0-9]{26}$/.test(row.reference)||typeof row.title!=='string'||!row.title||row.title.length>200)throw new Error();return {reference:row.reference,title:row.title};});
   return textToolResult({ok:true,candidates});
  }catch{return unavailable();}})();pending.add(work);
  try{return await work;}finally{pending.delete(work);active.delete(controller);}
 }}));
 return {
  bundle:():NativeBundle=>({name:'private-browser',version:1,tools,close:async()=>{}}),
  cancel(){for(const controller of active)controller.abort();},
  async close(){closed=true;for(const controller of active)controller.abort();await Promise.allSettled([...pending]);},
 };
}
