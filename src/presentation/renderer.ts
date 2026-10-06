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
  private readonly mergeVisibilityContainers = new Map<HTMLElement, HTMLElement>();

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
      const viewAdapter = this.viewAdapters.get(event.view);
      const previousContainer = this.mergeVisibilityContainers.get(element);
      const nextContainer = presentation.hiddenByMerge
        ? (viewAdapter?.mergeVisibilityContainer(element) ?? null)
        : null;
      if (previousContainer && previousContainer !== nextContainer) this.restore(previousContainer);
      if (nextContainer) {
        this.write(nextContainer, "display", "none", "important");
        this.rememberStyle(nextContainer);
        this.mergeVisibilityContainers.set(element, nextContainer);
      } else {
        this.mergeVisibilityContainers.delete(element);
      }
      this.apply(
        element,
        presentation,
        preferences.get((group?.canonical ?? event).calendarKey)?.color !== undefined ||
          (preferences.get((group?.canonical ?? event).calendarKey)?.opacity ?? 1) !== 1,
        geometryByCanonical.get(event.ref),
        viewAdapter,
      );
      this.rememberStyle(element);
    }

    const staleElements = changedElements ?? this.touched;
    for (const element of staleElements)
      if (!events.has(element) && this.touched.has(element)) {
        const visibilityContainer = this.mergeVisibilityContainers.get(element);
        if (visibilityContainer) this.restore(visibilityContainer);
        this.mergeVisibilityContainers.delete(element);
        this.restore(element);
      }
    this.previousEventsByElement = new Map(events);
    this.previousGroupsByEvent = groupsByEvent;
  }

  restoreAll(): void {
    for (const element of this.touched) this.restore(element);
    this.previousEventsByElement.clear();
    this.previousGroupsByEvent.clear();
    this.mergeVisibilityContainers.clear();
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
    this.write(element, "color", null, "important");
    const nativeForeground =
      element.ownerDocument.defaultView?.getComputedStyle(element).color ?? "";
    const foreground = hasAppearanceOverride
      ? readableForegroundColor(
          nativeForeground,
          presentation.backgroundColor,
          presentation.backgroundOpacity,
          resolveBackdropColor(element),
          presentation.spotlightFactor,
        )
      : null;
    this.write(element, "color", foreground, "important");

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
      this.write(element, "top", geometry.top ?? null, "important");
      this.write(element, "height", geometry.height ?? null, "important");
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
  const parsed = parseColor(color);
  if (!parsed) return null;
  const alpha = clampOpacity(opacity) * parsed.alpha;
  return `rgba(${parsed.red}, ${parsed.green}, ${parsed.blue}, ${alpha})`;
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

interface ParsedColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
}

const contrastThreshold = 4.5;
const darkForeground = "#202124";
const lightForeground = "#f8f9fa";

export function readableForegroundColor(
  currentForeground: string,
  backgroundColor: string,
  backgroundOpacity: number,
  backdropColor: string,
  elementOpacity = 1,
): string | null {
  const backdrop = parseColor(backdropColor);
  if (!backdrop) return darkForeground;

  const background = parseColor(backgroundColor);
  if (!background) return bestForeground(backdrop, elementOpacity);

  const backgroundAlpha = clampOpacity(backgroundOpacity) * background.alpha;
  const eventBackground = composite(background, backgroundAlpha, backdrop);
  const visibleBackground = composite(eventBackground, elementOpacity, backdrop);
  const foreground = parseColor(currentForeground);
  if (foreground) {
    const foregroundOnEvent = composite(foreground, foreground.alpha, eventBackground);
    const visibleForeground = composite(foregroundOnEvent, elementOpacity, backdrop);
    if (contrastRatio(visibleForeground, visibleBackground) >= contrastThreshold) return null;
  }

  return bestForeground(eventBackground, elementOpacity, backdrop);
}

function bestForeground(
  eventBackground: ParsedColor,
  elementOpacity = 1,
  backdrop = eventBackground,
): string {
  const dark = parseColor(darkForeground);
  const light = parseColor(lightForeground);
  if (!dark || !light) return darkForeground;
  const visibleBackground = composite(eventBackground, elementOpacity, backdrop);
  const darkRatio = contrastRatio(
    composite(composite(dark, dark.alpha, eventBackground), elementOpacity, backdrop),
    visibleBackground,
  );
  const lightRatio = contrastRatio(
    composite(composite(light, light.alpha, eventBackground), elementOpacity, backdrop),
    visibleBackground,
  );
  return darkRatio >= lightRatio ? darkForeground : lightForeground;
}

function resolveBackdropColor(element: HTMLElement): string {
  const document = element.ownerDocument;
  const window = document.defaultView;
  const darkMode = document.documentElement.getAttribute("data-theme")?.toLowerCase() === "dark";
  const fallback = darkMode ? "#202124" : "#ffffff";
  const base = parseColor(fallback);
  if (!window || !base) return fallback;

  const layers: ParsedColor[] = [];
  for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (style.backgroundImage && style.backgroundImage !== "none") return fallback;

    const background = parseColor(style.backgroundColor);
    if (!background) {
      if (style.backgroundColor && style.backgroundColor !== "transparent") return fallback;
    } else if (background.alpha > 0) {
      layers.push(background);
      if (background.alpha >= 1) break;
    }
    if (ancestor === document.documentElement) break;
  }

  let resolved = base;
  for (const layer of layers.toReversed()) resolved = composite(layer, layer.alpha, resolved);
  return `rgb(${Math.round(resolved.red)}, ${Math.round(resolved.green)}, ${Math.round(resolved.blue)})`;
}

function parseColor(value: string): ParsedColor | null {
  const normalized = value.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/u.exec(normalized);
  if (hex) {
    const raw = hex[1] ?? "";
    const digits = raw.length === 3 ? raw.replace(/./gu, (part) => `${part}${part}`) : raw;
    const channels = digits.match(/[\da-f]{2}/gu)?.map((part) => Number.parseInt(part, 16));
    if (channels?.length === 3)
      return { red: channels[0] ?? 0, green: channels[1] ?? 0, blue: channels[2] ?? 0, alpha: 1 };
  }

  const rgb =
    /^rgba?\(\s*([\d.]+)(%)?\s*,\s*([\d.]+)(%)?\s*,\s*([\d.]+)(%)?(?:\s*,\s*([\d.]+)(%)?)?\s*\)$/u.exec(
      normalized,
    );
  if (!rgb) return null;
  const components = [
    [rgb[1], rgb[2]],
    [rgb[3], rgb[4]],
    [rgb[5], rgb[6]],
  ].map(([component, unit]) => {
    const value = Number(component);
    return unit === "%" ? (value * 255) / 100 : value;
  });
  const alpha =
    rgb[7] === undefined ? 1 : clampOpacity(Number(rgb[7]) / (rgb[8] === "%" ? 100 : 1));
  if (components.some((component) => !Number.isFinite(component))) return null;
  return {
    red: clampChannel(components[0] ?? 0),
    green: clampChannel(components[1] ?? 0),
    blue: clampChannel(components[2] ?? 0),
    alpha,
  };
}

function clampOpacity(opacity: number): number {
  return Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;
}

function clampChannel(channel: number): number {
  return Math.min(255, Math.max(0, channel));
}

function composite(foreground: ParsedColor, opacity: number, backdrop: ParsedColor): ParsedColor {
  const alpha = clampOpacity(opacity);
  return {
    red: foreground.red * alpha + backdrop.red * (1 - alpha),
    green: foreground.green * alpha + backdrop.green * (1 - alpha),
    blue: foreground.blue * alpha + backdrop.blue * (1 - alpha),
    alpha: 1,
  };
}

function contrastRatio(left: ParsedColor, right: ParsedColor): number {
  const leftLuminance = relativeLuminance(left);
  const rightLuminance = relativeLuminance(right);
  return (
    (Math.max(leftLuminance, rightLuminance) + 0.05) /
    (Math.min(leftLuminance, rightLuminance) + 0.05)
  );
}

function relativeLuminance(color: ParsedColor): number {
  const channels = [color.red, color.green, color.blue].map((channel) => {
    const linear = channel / 255;
    return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
