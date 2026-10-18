/** Telegram surface helpers. A private surface is the paired user's chat; a
 * household group is one exact chat with two distinct named actors. */
export type GroupActor={id:number;label:'Isaac'|'Emma'};
export interface GroupSurface{chatId:number;actors:readonly [GroupActor,GroupActor]}
export interface SurfaceConfig{transport:{allowedUserId:number};group?:GroupSurface}
export const chatIdOf=(config:SurfaceConfig):number=>config.group?.chatId??config.transport.allowedUserId;
/** Authenticated actor; undefined for a stranger. Private surfaces have one unlabeled actor. */
export function actorOf(config:SurfaceConfig,userId:unknown):{id:number;label?:string}|undefined {
 if(typeof userId!=='number')return undefined;
 if(config.group)return config.group.actors.find(actor=>actor.id===userId);
 return userId===config.transport.allowedUserId?{id:userId}:undefined;
}
