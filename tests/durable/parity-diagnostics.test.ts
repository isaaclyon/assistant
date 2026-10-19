import { afterEach,expect,test,vi } from 'vitest';
import { fauxAssistantMessage,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { setup,cleanup } from './parity-application-fixture.js';
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const call=(name:string,args:unknown)=>fauxAssistantMessage(fauxToolCall(name,args as never),{stopReason:'toolUse'});

test('integration debug names Google, places and protected browser work without exposing arguments or domain extras',async()=>{
 const s=await setup();s.behavior.input=async()=>({status:'submitted',secret:'DOMAIN_SECRET_NEVER_VISIBLE'});
 await s.open([
  call('google_workspace',{operation:'account_status'}),
  call('rank_places',{action:'categories'}),
  call('private_browser_input',{session:'fictional',pageUrl:'https://example.com/login?token=SENSITIVE_URL_QUERY',resumeUrl:'https://example.com/',fields:[{kind:'password',selector:'#private-field-selector'}],submitSelector:'#submit'}),
  fauxAssistantMessage('INTEGRATIONS_DONE'),
 ]);
 await s.accept('/debug');await s.accept('Inspect synthetic integrations.');
 await vi.waitFor(()=>expect(s.finals).toContain('INTEGRATIONS_DONE'),{timeout:8000});
 for(const name of ['google_workspace','rank_places','private_browser_input'])expect(s.presented.some(text=>text.includes('durable tool')&&text.includes(name)),name).toBe(true);
 const debug=s.presented.filter(text=>text.startsWith('Debug\n'));expect(debug.length).toBeGreaterThan(0);
 expect(debug.every(text=>text.length<=3500)).toBe(true);
 expect(debug.join('\n')).not.toMatch(/SENSITIVE_URL_QUERY|private-field-selector|DOMAIN_SECRET_NEVER_VISIBLE|account_status/);
 expect(JSON.stringify(s.requests)).not.toContain('DOMAIN_SECRET_NEVER_VISIBLE');
 expect(s.fatal).toHaveLength(0);
});
