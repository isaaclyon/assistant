import { isAbsolute, normalize } from 'node:path';
export type BridgeRuntimeGeneration='legacy'|'pi-durable';
const entrypoints={legacy:'/dist/src/daemon.js','pi-durable':'/dist/src/durable/daemon.js',broker:'/dist/src/trusted-broker-daemon.js'} as const;
/** A release has one dependency tree. Never discover a runtime by importing it. */
export function releaseFromEntrypoint(executable:string):{release:string;runtime:BridgeRuntimeGeneration|'broker'} {
 if(!isAbsolute(executable)||normalize(executable)!==executable||/[\0\r\n]/.test(executable))throw new Error('Invalid previous bridge binary');
 for(const [runtime,suffix] of Object.entries(entrypoints))if(executable.endsWith(suffix)){
  const release=executable.slice(0,-suffix.length);if(!release||release==='/')break;
  return {release,runtime:runtime as BridgeRuntimeGeneration|'broker'};
 }
 throw new Error('Invalid previous bridge binary');
}
export function runtimeEntrypoint(release:string,runtime:BridgeRuntimeGeneration|'broker'):string {
 if(!isAbsolute(release)||normalize(release)!==release||release==='/'||/[\0\r\n]/.test(release)||!Object.hasOwn(entrypoints,runtime))throw new Error('Invalid runtime release path');
 return release+entrypoints[runtime];
}
