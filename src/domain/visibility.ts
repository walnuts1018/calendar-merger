import type { CalendarGroup, VisibilityProfile } from "./model";

export interface VisibilityChange {
  calendarKey: string;
  visible: boolean;
}

export function visibilityChanges(
  current: ReadonlyMap<string, boolean>,
  desired: ReadonlySet<string>,
): VisibilityChange[] {
  const changes: VisibilityChange[] = [];
  for (const [calendarKey, visible] of current) {
    const shouldBeVisible = desired.has(calendarKey);
    if (visible !== shouldBeVisible) changes.push({ calendarKey, visible: shouldBeVisible });
  }
  return changes;
}

export function groupVisibilityTarget(
  group: CalendarGroup,
  current: ReadonlyMap<string, boolean>,
): boolean {
  return !group.calendarKeys.some((key) => current.get(key) === true);
}

export function profileVisibilityChanges(
  profile: VisibilityProfile,
  current: ReadonlyMap<string, boolean>,
): VisibilityChange[] {
  return visibilityChanges(current, new Set(profile.visibleCalendarKeys));
}

export class SoloVisibilityTransaction {
  private original: Map<string, boolean> | undefined;

  get active(): boolean {
    return this.original !== undefined;
  }

  enter(
    targetCalendarKeys: ReadonlySet<string>,
    current: ReadonlyMap<string, boolean>,
  ): VisibilityChange[] {
    this.original ??= new Map(current);
    for (const key of targetCalendarKeys) {
      const visible = current.get(key);
      if (visible !== undefined && !this.original.has(key)) this.original.set(key, visible);
    }
    const managedCurrent = new Map(
      [...current].filter(([key]) => this.original?.has(key) ?? false),
    );
    return visibilityChanges(
      managedCurrent,
      new Set([...targetCalendarKeys].filter((key) => managedCurrent.has(key))),
    );
  }

  restore(current: ReadonlyMap<string, boolean>): VisibilityChange[] {
    if (!this.original) return [];
    const changes = [...this.original].flatMap(([calendarKey, visible]) =>
      current.has(calendarKey) && current.get(calendarKey) !== visible
        ? [{ calendarKey, visible }]
        : [],
    );
    this.original = undefined;
    return changes;
  }
}
