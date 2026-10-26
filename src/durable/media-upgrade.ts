import { isDeepStrictEqual } from 'node:util';
import { basename, dirname } from 'node:path';

const selectors=['instructionUpgradeFrom','scheduleUpgradeFrom','mediaUpgradeFrom'];
/** Permit only the media-stack bundle arriving in a newer release. Every other
 * identity, authority and tool setting must match the pinned predecessor. */
export function assertMediaOnlyUpgrade(current:Record<string,unknown>,previous:Record<string,unknown>):void {
 const withoutMedia=(input:Record<string,unknown>)=>Object.fromEntries(Object.entries(input).filter(([key])=>!['releaseSha','resourceRoot','mediaStack',...selectors].includes(key)));
 if(!isDeepStrictEqual(withoutMedia(current),withoutMedia(previous)))throw new Error('Media upgrade cannot change other runtime authority');
 if(previous.mediaStack!==undefined)throw new Error('Media upgrade requires a predecessor without media configuration');
 if(current.releaseSha===previous.releaseSha)throw new Error('Media upgrade requires a distinct reviewed release');
 if(typeof current.resourceRoot!=='string'||typeof previous.resourceRoot!=='string'||basename(current.resourceRoot)!==current.releaseSha||basename(previous.resourceRoot)!==previous.releaseSha||dirname(current.resourceRoot)!==dirname(previous.resourceRoot))throw new Error('Media upgrade requires retained sibling SHA-named releases');
}
