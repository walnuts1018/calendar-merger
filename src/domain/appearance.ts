import type { CalendarEvent, CalendarPreferences, EventPresentation, MergeGroup } from "./model";

export interface AppearanceInput {
  event: CalendarEvent;
  mergeGroup?: MergeGroup;
  calendars: ReadonlyMap<string, CalendarPreferences>;
  nativeColors: ReadonlyMap<string, string | undefined>;
  spotlightCalendarKeys: ReadonlySet<string>;
  spotlightActive: boolean;
  dimFactor?: number;
}

export function normalizeOpacity(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function calendarColor(
  calendarKey: string,
  calendars: ReadonlyMap<string, CalendarPreferences>,
  nativeColors: ReadonlyMap<string, string | undefined>,
): string {
  return calendars.get(calendarKey)?.color ?? nativeColors.get(calendarKey) ?? "#4285f4";
}

export function composeEventPresentation(input: AppearanceInput): EventPresentation {
  const { event, mergeGroup, calendars, nativeColors, spotlightCalendarKeys } = input;
  const canonical = mergeGroup?.canonical ?? event;
  const keys = mergeGroup?.calendarKeys ?? [event.calendarKey];
  const preference = calendars.get(canonical.calendarKey);
  const highlighted = keys.some((key) => spotlightCalendarKeys.has(key));
  const dimFactor = normalizeOpacity(input.dimFactor ?? 0.18);
  const colors = [...new Set(keys.map((key) => calendarColor(key, calendars, nativeColors)))];

  return {
    backgroundColor: calendarColor(canonical.calendarKey, calendars, nativeColors),
    backgroundOpacity: normalizeOpacity(preference?.opacity ?? 1),
    spotlightFactor: input.spotlightActive && !highlighted ? dimFactor : 1,
    hiddenByMerge: Boolean(mergeGroup && mergeGroup.canonical.ref !== event.ref),
    mergedCalendarColors: colors,
    mergedCount: mergeGroup?.members.length ?? 1,
  };
}
