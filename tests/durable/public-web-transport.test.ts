import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request as httpRequest } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { createPublicWebBundle } from '../../src/durable/public-web.js';

vi.mock('node:http', async importOriginal=>({...await importOriginal<typeof import('node:http')>(),request:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
const run=()=>createPublicWebBundle({lookup:async()=>[{address:'93.184.216.34',family:4}]}).tools[0]!.tool.execute({url:'http://public.example/source'} as never,{} as ToolExecutionApi,BACKGROUND_CONTEXT);

test('default HTTP transport passes pinned lookup and abort signal, and consumes its real readable response',async()=>{
 let observed:any;
 vi.mocked(httpRequest).mockImplementation(((url:URL,options:any,receive:(response:Readable)=>void)=>{
  observed={url,options};
  const client=new EventEmitter() as EventEmitter&{end():void};
  client.end=()=>queueMicrotask(()=>receive(Object.assign(Readable.from([Buffer.from('TRANSPORT_BODY')]),{statusCode:200,headers:{'content-type':'text/plain'}})));
  return client;
 }) as unknown as typeof httpRequest);
 const result=await run();
 expect(JSON.stringify(result)).toContain('TRANSPORT_BODY');
 expect(observed.url.href).toBe('http://public.example/source');
 expect(observed.options.signal).toBeInstanceOf(AbortSignal);
 expect(observed.options.agent).toBe(false);expect(observed.options.headers.connection).toBe('close');
 const resolved=await new Promise(resolve=>observed.options.lookup('public.example',{all:true},(error:Error|null,addresses:unknown)=>resolve({error,addresses})));
 expect(resolved).toEqual({error:null,addresses:[{address:'93.184.216.34',family:4}]});
});

test('default HTTP transport surfaces connection failures',async()=>{
 vi.mocked(httpRequest).mockImplementation((()=>{
  const client=new EventEmitter() as EventEmitter&{end():void};client.end=()=>queueMicrotask(()=>client.emit('error',new Error('SYNTHETIC_CONNECT_FAILURE')));return client;
 }) as unknown as typeof httpRequest);
 const result=await run();expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('SYNTHETIC_CONNECT_FAILURE');
});
