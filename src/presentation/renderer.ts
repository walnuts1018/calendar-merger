import type {
  CalendarEvent,
  CalendarSnapshot,
  EventPresentation,
  MergeGroup,
} from "../domain/model";
import type { CalendarViewAdapter, MergedGeometry } from "../gcal/view-adapter";
import type { Settings } from "../storage/settings";

import { composeEventPresentation } from "../domain/appearance";
import { groupMergeCandidates } from "../domain/merge";

interface OriginalStyle {
  value: string;
  priority: string;
  applied: string;
}

interface OriginalPresentation {
  styles: Map<string, OriginalStyle>;
}

export class EventRenderer {
  private readonly originals = new WeakMap<HTMLElement, OriginalPresentation>();
  private readonly renderedStyles = new WeakMap<HTMLElement, string | null>();
  private readonly touched = new Set<HTMLElement>();
  private previousEventsByElement = new Map<HTMLElement, CalendarEvent>();
  private previousGroupsByEvent = new Map<string, MergeGroup>();
  private readonly geometryByMergeKey = new Map<
    string,
    { memberRefs: string; geometry: MergedGeometry }
  >();

  constructor(private readonly viewAdapters: ReadonlyMap<string, CalendarViewAdapter>) {}

  render(
    events: ReadonlyMap<HTMLElement, CalendarEvent>,
    calendars: readonly CalendarSnapshot[],
    settings: Settings,
    spotlightCalendarKeys: ReadonlySet<string>,
    changedElements?: ReadonlySet<HTMLElement>,
  ): void {
    const mergeCandidates = settings.mergeEnabled
      ? groupMergeCandidates(
          [...events.values()],
          (event) => this.viewAdapters.get(event.view)?.createMergeKey(event) ?? null,
        )
      : [];
    const eventElements = new Map(
      [...events].map(([element, event]) => [event.ref, element] as const),
    );
    const mergeGroups: MergeGroup[] = [];
    const geometryByCanonical = new Map<string, MergedGeometry>();
    const activeMergeKeys = new Set<string>();
    for (const group of mergeCandidates) {
      activeMergeKeys.add(group.key);
      const memberRefs = group.members
        .map(({ ref }) => ref)
        .toSorted()
        .join("\u0000");
      const cached = this.geometryByMergeKey.get(group.key);
      const assessment =
        cached?.memberRefs === memberRefs
          ? { safe: true as const, geometry: cached.geometry }
          : this.viewAdapters
              .get(group.canonical.view)
              ?.applyMergedGeometry(group.members, eventElements);
      if (!assessment?.safe) {
        this.geometryByMergeKey.delete(group.key);
        continue;
      }
      mergeGroups.push(group);
      if (assessment.geometry) {
        this.geometryByMergeKey.set(group.key, { memberRefs, geometry: assessment.geometry });
        geometryByCanonical.set(group.canonical.ref, assessment.geometry);
      } else {
        this.geometryByMergeKey.delete(group.key);
      }
    }
    for (const key of this.geometryByMergeKey.keys())
      if (!activeMergeKeys.has(key)) this.geometryByMergeKey.delete(key);

    const groupsByEvent = new Map<string, (typeof mergeGroups)[number]>();
    for (const group of mergeGroups)
      for (const member of group.members) groupsByEvent.set(member.ref, group);

    const affectedRefs = new Set<string>();
    if (!changedElements) {
      for (const event of events.values()) affectedRefs.add(event.ref);
    } else {
      const changedRefs = new Set<string>();
      for (const element of changedElements) {
        const previous = this.previousEventsByElement.get(element);
        const current = events.get(element);
        if (previous) changedRefs.add(previous.ref);
        if (current) changedRefs.add(current.ref);
      }
      for (const ref of changedRefs) {
        affectedRefs.add(ref);
        for (const member of this.previousGroupsByEvent.get(ref)?.members ?? [])
          affectedRefs.add(member.ref);
        for (const member of groupsByEvent.get(ref)?.members ?? []) affectedRefs.add(member.ref);
      }
    }
    const affectedElements = new Set<HTMLElement>();
    for (const ref of affectedRefs) {
      const element = eventElements.get(ref);
      if (element) affectedElements.add(element);
    }

    const nativeColors = new Map(calendars.map(({ key, nativeColor }) => [key, nativeColor]));
    const preferences = new Map(Object.entries(settings.calendars));
    const spotlightActive = spotlightCalendarKeys.size > 0;

    for (const [element, event] of events) {
      if (!affectedElements.has(element)) continue;
      const group = groupsByEvent.get(event.ref);
      const presentation = composeEventPresentation({
        event,
        ...(group ? { mergeGroup: group } : {}),
        calendars: preferences,
        nativeColors,
        spotlightCalendarKeys,
        spotlightActive,
      });
      this.apply(
        element,
        presentation,
        preferences.get((group?.canonical ?? event).calendarKey)?.color !== undefined ||
          (preferences.get((group?.canonical ?? event).calendarKey)?.opacity ?? 1) !== 1,
        geometryByCanonical.get(event.ref),
        this.viewAdapters.get(event.view),
      );
      this.rememberStyle(element);
    }

    const staleElements = changedElements ?? this.touched;
    for (const element of staleElements)
      if (!events.has(element) && this.touched.has(element)) this.restore(element);
    this.previousEventsByElement = new Map(events);
    this.previousGroupsByEvent = groupsByEvent;
  }

  restoreAll(): void {
    for (const element of this.touched) this.restore(element);
    this.previousEventsByElement.clear();
    this.previousGroupsByEvent.clear();
    this.geometryByMergeKey.clear();
  }

  invalidateGeometry(): void {
    for (const [element, event] of this.previousEventsByElement) {
      this.viewAdapters
        .get(event.view)
        ?.restoreGeometry(element, (property) => this.write(element, property, null, "important"));
      this.rememberStyle(element);
    }
    this.geometryByMergeKey.clear();
  }

  isOwnStyleMutation(element: HTMLElement): boolean {
    return (
      this.renderedStyles.has(element) &&
      element.getAttribute("style") === this.renderedStyles.get(element)
    );
  }

  private apply(
    element: HTMLElement,
    presentation: EventPresentation,
    hasAppearanceOverride: boolean,
    geometry: MergedGeometry | undefined,
    viewAdapter: CalendarViewAdapter | undefined,
  ): void {
    const color = hasAppearanceOverride
      ? toRgba(presentation.backgroundColor, presentation.backgroundOpacity)
      : null;
    this.write(element, "background-color", color, "important");
    this.write(
      element,
      "opacity",
      presentation.spotlightFactor < 1 ? String(presentation.spotlightFactor) : null,
      "important",
    );
    this.write(element, "visibility", presentation.hiddenByMerge ? "hidden" : null, "important");
    this.write(element, "pointer-events", presentation.hiddenByMerge ? "none" : null, "important");
    if (geometry) {
      this.write(element, "left", geometry.left, "important");
      this.write(element, "width", geometry.width, "important");
    } else {
      viewAdapter?.restoreGeometry(element, (property) =>
        this.write(element, property, null, "important"),
      );
    }

    const stripes =
      presentation.mergedCount > 1 ? stripeGradient(presentation.mergedCalendarColors) : null;
    this.write(element, "background-image", stripes, "important");
    this.write(element, "background-size", stripes ? "5px 100%" : null, "important");
    this.write(element, "background-position", stripes ? "left top" : null, "important");
    this.write(element, "background-repeat", stripes ? "no-repeat" : null, "important");
  }

  private write(
    element: HTMLElement,
    property: string,
    value: string | null,
    priority: string,
  ): void {
    let original = this.originals.get(element);
    if (!original) {
      original = { styles: new Map() };
      this.originals.set(element, original);
    }

    const currentValue = element.style.getPropertyValue(property);
    const currentPriority = element.style.getPropertyPriority(property);
    const state = original.styles.get(property);
    if (!state || currentValue !== state.applied) {
      original.styles.set(property, {
        value: currentValue,
        priority: currentPriority,
        applied: "",
      });
    }

    const updatedState = original.styles.get(property);
    if (!value) {
      if (updatedState) {
        if (updatedState.value)
          element.style.setProperty(property, updatedState.value, updatedState.priority);
        else element.style.removeProperty(property);
        original.styles.delete(property);
      }
    } else {
      element.style.setProperty(property, value, priority);
      const applied = original.styles.get(property);
      if (applied) applied.applied = element.style.getPropertyValue(property);
    }

    if (original.styles.size > 0) this.touched.add(element);
    else this.touched.delete(element);
  }

  private restore(element: HTMLElement): void {
    const original = this.originals.get(element);
    if (original) {
      for (const [property, state] of original.styles) {
        if (element.style.getPropertyValue(property) !== state.applied) continue;
        if (state.value) element.style.setProperty(property, state.value, state.priority);
        else element.style.removeProperty(property);
      }
      this.originals.delete(element);
    }
    element.querySelectorAll(":scope > [data-gce-overlay]").forEach((overlay) => overlay.remove());
    this.touched.delete(element);
    this.rememberStyle(element);
  }

  private rememberStyle(element: HTMLElement): void {
    this.renderedStyles.set(element, element.getAttribute("style"));
  }
}

function toRgba(color: string, opacity: number): string | null {
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(color.trim());
  if (hex) {
    const raw = hex[1] ?? "";
    const normalized = raw.length === 3 ? raw.replace(/./gu, (part) => `${part}${part}`) : raw;
    const channels = normalized.match(/[\da-f]{2}/giu)?.map((part) => Number.parseInt(part, 16));
    if (channels?.length === 3)
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${opacity})`;
  }

  const rgb =
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*[\d.]+)?\s*\)$/iu.exec(
      color.trim(),
    );
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${opacity})`;
  return null;
}

function stripeGradient(colors: readonly string[]): string | null {
  const rgbaColors = colors
    .map((color) => toRgba(color, 1))
    .filter((color): color is string => color !== null);
  if (rgbaColors.length < 2) return null;
  const stops = rgbaColors.map(
    (color, index) =>
      `${color} ${(index / rgbaColors.length) * 100}% ${((index + 1) / rgbaColors.length) * 100}%`,
  );
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}
