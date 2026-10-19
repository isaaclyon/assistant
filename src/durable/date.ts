import { DATE_TEXT_LIMIT, renderDateContext, resolveDateContext, type DateContext } from '../date-context.js';

export { renderDateContext, type DateContext };

/**
 * Date interpretation for one accepted human message. The reference is the original
 * accepted event time, so retries, recovery and later replays resolve identically.
 * Returns undefined when nothing needs a hint or the time cannot anchor relative dates.
 */
export function resolveTurnDates(text: string, reference: { originalAt: number; timeZone: string }): DateContext | undefined {
  if (!Number.isSafeInteger(reference.originalAt) || reference.originalAt <= 0) return undefined;
  const context = resolveDateContext(text.trim().slice(0, DATE_TEXT_LIMIT), { sentAtMs: reference.originalAt, timeZone: reference.timeZone });
  return context.ranges.length || context.unresolved.length ? context : undefined;
}
