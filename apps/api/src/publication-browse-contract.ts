import { z } from 'zod';

const number=z.number().int().nonnegative().safe(),uuid=z.string().uuid();
export const publicationNoticeCursor=z.object({recordedAt:number,id:uuid}).strict();
export const publicationHistoryCursor=z.object({revision:number.positive()}).strict();
export const publicationNoticePage=z.object({
  notices:z.array(z.object({publicationId:uuid,month:z.string().regex(/^20\d\d-(0[1-9]|1[0-2])$/),recordedAt:number,readAt:number.nullable()})),
  nextCursor:publicationNoticeCursor.nullable(),
});
export const publicationHistoryPage=z.object({
  versions:z.array(z.object({publicationId:uuid,publicationRevision:number.positive(),inputRevision:number,recordedAt:number,actorId:uuid,actorName:z.string(),sourceKind:z.enum(['job','draft','cancellation']),sourceId:uuid})),
  nextCursor:publicationHistoryCursor.nullable(),
});
const decimal=z.string().regex(/^(0|[1-9]\d*)$/).transform(Number).pipe(number);
export function noticeCursorQuery(query:Record<string,string>){
  if(query.cursorTime===undefined&&query.cursorId===undefined)return undefined;
  return publicationNoticeCursor.parse({recordedAt:decimal.parse(query.cursorTime),id:query.cursorId});
}
export function historyCursorQuery(query:Record<string,string>){
  return query.cursorRevision===undefined?undefined:publicationHistoryCursor.parse({revision:decimal.parse(query.cursorRevision)});
}
