import type {
  AdapterCapabilities,
  CalendarEvent,
  CalendarSnapshot,
  CalendarView,
} from "../domain/model";
import type { CalendarViewAdapter } from "./view-adapter";

import {
  calendarConfidence,
  calendarFallbackKey,
  calendarOwnership,
  decodeCalendarIdFromEventId,
  readCalendarId,
  resolveCalendarByLabel,
} from "./identity";
import { createCalendarViewAdapters } from "./view-adapter";

const calendarControlSelector =
  '[role="group"] [role="checkbox"][aria-label], [role="group"] input[type="checkbox"][aria-label], [role="group"] [role="switch"][aria-label], [role="list"] [role="checkbox"][aria-label], [role="list"] input[type="checkbox"][aria-label]';
const eventSelector =
  "[data-eventchip][data-eventid], [data-eventid][data-event-title], [data-event-id], [data-gce-event]";

export interface Disposable {
  dispose(): void;
}

export class GoogleCalendarDomAdapter {
  private calendars: CalendarSnapshot[] = [];
  private readonly calendarControls = new WeakMap<Element, CalendarSnapshot>();
  private readonly calendarToggleElements = new Map<string, HTMLElement>();
  private readonly calendarRowElements = new Map<string, HTMLElement>();
  private readonly calendarControlContainers = new Map<string, HTMLElement>();
  private readonly calendarPanelContainers = new Map<string, HTMLElement>();
  private readonly eventRefs = new WeakMap<Element, string>();
  private readonly eventCalendarRefs = new WeakMap<
    Element,
    { eventId: string; calendarKey: string }
  >();
  private nextEventRef = 0;

  constructor(
    private readonly document: Document,
    private readonly viewAdapters: ReadonlyMap<
      CalendarView,
      CalendarViewAdapter
    > = createCalendarViewAdapters(),
  ) {}

  observeCalendars(callback: (dirty: ReadonlySet<Node>) => void): Disposable {
    return this.observe(callback, ["aria-label", "aria-checked", "checked"]);
  }

  observeEvents(callback: (dirty: ReadonlySet<Node>) => void): Disposable {
    return this.observe(callback, [
      "aria-label",
      "aria-checked",
      "checked",
      "data-start",
      "data-end",
      "data-event-title",
      "title",
      "data-eventid",
      "data-event-id",
      "data-gce-event",
      "data-calendar-id",
      "data-calendarid",
      "data-calendar-name",
      "data-calendar-owner",
      "data-all-day",
      "hidden",
    ]);
  }

  listCalendars(): CalendarSnapshot[] {
    const controls = [...this.document.querySelectorAll<HTMLElement>(calendarControlSelector)];
    const bases = controls.map((control) => {
      const row = this.calendarRow(control);
      if (!row) return null;
      const controlContainer = this.calendarControlContainer(control, row);
      if (!controlContainer) return null;
      const panelContainer = this.calendarPanelContainer(row);
      const label = this.calendarLabel(control, row);
      const nativeColor = this.nativeColor(row);
      const section = this.calendarSectionKey(row);
      return {
        control,
        row,
        controlContainer,
        panelContainer,
        label,
        nativeColor,
        section,
        base: `${section}\u0000${label}`,
      };
    });
    const baseCounts = new Map<string, number>();
    for (const entry of bases) {
      if (entry) baseCounts.set(entry.base, (baseCounts.get(entry.base) ?? 0) + 1);
    }
    const keyCounts = new Map<string, number>();
    for (const entry of bases) {
      if (!entry?.label || entry.row.closest("[data-gce-ui]")) continue;
      const id = readCalendarId(entry.row);
      const key = id ? `calendar:${id}` : calendarFallbackKey(entry.label, entry.section);
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    const calendars: CalendarSnapshot[] = [];
    this.calendarToggleElements.clear();
    this.calendarRowElements.clear();
    this.calendarControlContainers.clear();
    this.calendarPanelContainers.clear();

    for (const entry of bases) {
      if (!entry || !entry.label || entry.row.closest("[data-gce-ui]")) continue;
      const { control, row, controlContainer, panelContainer, label, nativeColor, section, base } =
        entry;
      const id = readCalendarId(row);
      const key = id ? `calendar:${id}` : calendarFallbackKey(label, section);
      const confidence =
        keyCounts.get(key) === 1
          ? calendarConfidence(row, label, baseCounts.get(base) === 1)
          : "weak";

      const snapshot: CalendarSnapshot = {
        key,
        label,
        confidence,
        ownership: calendarOwnership(row),
        visible: this.isCalendarVisible(control),
        ...(nativeColor ? { nativeColor } : {}),
      };
      this.calendarControls.set(control, snapshot);
      this.calendarControls.set(row, snapshot);
      if (confidence !== "weak") {
        this.calendarToggleElements.set(key, control);
        this.calendarRowElements.set(key, row);
        this.calendarControlContainers.set(key, controlContainer);
        this.calendarPanelContainers.set(key, panelContainer);
      }
      calendars.push(snapshot);
    }

    this.calendars = calendars;
    return calendars;
  }

  getCalendarToggleElement(calendarKey: string): HTMLElement | null {
    return this.calendarToggleElements.get(calendarKey) ?? null;
  }

  getCalendarRowElement(calendarKey: string): HTMLElement | null {
    return this.calendarRowElements.get(calendarKey) ?? null;
  }

  getCalendarControlContainer(calendarKey: string): HTMLElement | null {
    return this.calendarControlContainers.get(calendarKey) ?? null;
  }

  getCalendarPanelContainer(calendarKey: string): HTMLElement | null {
    return this.calendarPanelContainers.get(calendarKey) ?? null;
  }

  getCalendars(): readonly CalendarSnapshot[] {
    return this.calendars;
  }

  getCapabilities(events: readonly CalendarEvent[]): AdapterCapabilities {
    const calendarIdentity =
      this.calendars.filter(({ confidence }) => confidence !== "weak").length >= 2;
    const eventIdentity = events.some(({ eventConfidence }) => eventConfidence !== "weak");
    const eventStyling = events.length > 0;
    return {
      calendarIdentity,
      eventIdentity,
      calendarSidebar: this.calendars.length > 0,
      eventStyling,
      merge:
        calendarIdentity &&
        eventIdentity &&
        eventStyling &&
        events.some(({ view }) => view !== "unknown"),
    };
  }

  hasCalendarChanges(dirty: ReadonlySet<Node>): boolean {
    return this.dirtyElements(dirty, calendarControlSelector).length > 0;
  }

  resolveDirtyEventElements(dirty: ReadonlySet<Node>): HTMLElement[] {
    return this.dirtyElements(dirty, eventSelector);
  }

  listVisibleEvents(): CalendarEvent[] {
    return this.listVisibleEventEntries().map(({ event }) => event);
  }

  listVisibleEventEntries(): Array<{ element: HTMLElement; event: CalendarEvent }> {
    const entries: Array<{ element: HTMLElement; event: CalendarEvent }> = [];
    const elements = [...this.document.querySelectorAll<HTMLElement>(eventSelector)].filter(
      (element) => !element.closest("[data-gce-ui], [data-gce-overlay]"),
    );
    for (const [domOrder, element] of elements.entries()) {
      const event = this.resolveEvent(element, domOrder);
      if (event) entries.push({ element, event });
    }
    return entries;
  }

  resolveCalendar(element: Element): CalendarSnapshot | null {
    const direct = this.calendarControls.get(element);
    if (direct) return direct;

    const row = element.closest('[role="listitem"], [role="treeitem"]');
    if (row) {
      const stored = this.calendarControls.get(row);
      if (stored) return stored;
      const id = readCalendarId(row);
      if (id) {
        const known = this.calendars.find((calendar) => calendar.key === `calendar:${id}`);
        if (known) return known;
      }
      const label = this.calendarLabel(row, row);
      return label ? resolveCalendarByLabel(label, this.calendars) : null;
    }

    const id = readCalendarId(element);
    if (id) return this.calendars.find((calendar) => calendar.key === `calendar:${id}`) ?? null;
    const label = element.getAttribute("data-calendar-name");
    return label ? resolveCalendarByLabel(label, this.calendars) : null;
  }

  resolveEvent(element: Element, domOrder = 0): CalendarEvent | null {
    const view = this.getCurrentView();
    const viewAdapter = this.viewAdapters.get(view);
    if (!viewAdapter) return null;
    return viewAdapter.extractEvent(element, domOrder, {
      resolveCalendar: (eventElement) => this.eventCalendar(eventElement),
      getEventRef: (eventElement) => this.eventRef(eventElement),
    });
  }

  getViewAdapters(): ReadonlyMap<CalendarView, CalendarViewAdapter> {
    return this.viewAdapters;
  }

  getCurrentView(): CalendarView {
    const viewAttribute = this.document.documentElement.getAttribute("data-calendar-view");
    const location = this.document.defaultView?.location;
    const queryView = new URLSearchParams(location?.search ?? "").get("view");
    const route =
      `${location?.pathname ?? ""}/${viewAttribute ?? ""}/${queryView ?? ""}`.toLowerCase();
    if (/year|\byear\b/u.test(route)) return "year";
    if (/month|\bmonth\b/u.test(route)) return "month";
    if (/schedule|agenda|\bagenda\b/u.test(route)) return "schedule";
    if (/week|\bweek\b/u.test(route)) return "week";
    if (/day|\bday\b/u.test(route)) return "day";
    return "unknown";
  }

  private observe(
    callback: (dirty: ReadonlySet<Node>) => void,
    attributeFilter: string[],
  ): Disposable {
    const Observer = this.document.defaultView?.MutationObserver;
    if (!Observer || !this.document.body) return { dispose() {} };
    const pending = new Set<Node>();
    const observer = new Observer((records) => {
      for (const record of records) {
        pending.add(record.target);
        for (const node of record.addedNodes) pending.add(node);
        for (const node of record.removedNodes) pending.add(node);
      }
      queueMicrotask(() => {
        if (pending.size === 0) return;
        const batch = new Set(pending);
        pending.clear();
        callback(batch);
      });
    });
    observer.observe(this.document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter,
    });
    return { dispose: () => observer.disconnect() };
  }

  private dirtyElements(dirty: ReadonlySet<Node>, selector: string): HTMLElement[] {
    const elements = new Set<HTMLElement>();
    for (const node of dirty) {
      const element =
        node.nodeType === 1
          ? (node as Element)
          : node.nodeType === 3 && node.parentElement
            ? node.parentElement
            : null;
      if (!element) continue;
      if (element.matches(selector)) elements.add(element as HTMLElement);
      const closest = element.closest<HTMLElement>(selector);
      if (closest) elements.add(closest);
      for (const descendant of element.querySelectorAll<HTMLElement>(selector))
        elements.add(descendant);
    }
    return [...elements];
  }

  private calendarRow(control: Element): HTMLElement | null {
    return (control.closest<HTMLElement>('[role="listitem"], [role="treeitem"]') ??
      control.parentElement) as HTMLElement | null;
  }

  private calendarControlContainer(control: Element, row: HTMLElement): HTMLElement | null {
    const window = this.document.defaultView;
    if (!window) return row;
    let flexContainer: HTMLElement | null = null;
    for (
      let candidate = control.parentElement;
      candidate && candidate !== row;
      candidate = candidate.parentElement
    ) {
      const display = window.getComputedStyle(candidate).display;
      if (display === "flex" || display === "inline-flex") flexContainer = candidate;
    }
    return flexContainer ?? row;
  }

  private calendarPanelContainer(row: HTMLElement): HTMLElement {
    const parent = row.parentElement;
    if (!parent) return row;
    const style = this.document.defaultView?.getComputedStyle(parent);
    if (
      style?.display === "block" ||
      (style?.display === "flex" && style.flexDirection === "column")
    )
      return parent;
    return row;
  }

  private calendarLabel(control: Element, row: Element): string {
    const semantic = row.querySelector("[data-calendar-name]")?.getAttribute("data-calendar-name");
    if (semantic?.trim()) return semantic.trim();
    const title = row.querySelector<HTMLElement>("[title]")?.title;
    if (title?.trim()) return title.trim();
    const controlLabel = control.getAttribute("aria-label");
    if (controlLabel?.trim()) return controlLabel.trim();
    return row.textContent?.trim().replace(/\s+/gu, " ") ?? "";
  }

  private nativeColor(row: Element): string | undefined {
    const semantic = row
      .querySelector("[data-calendar-color]")
      ?.getAttribute("data-calendar-color");
    if (semantic) return semantic;
    const colored = [...row.querySelectorAll<HTMLElement>("*")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const color = this.document.defaultView?.getComputedStyle(element).backgroundColor;
        return {
          area: rect.width * rect.height,
          color,
          small: rect.width <= 32 && rect.height <= 32,
        };
      })
      .filter(
        ({ color }) => color && color !== "transparent" && !/^rgba\(0, 0, 0, 0\)$/u.test(color),
      );
    const visible = colored.filter(({ area }) => area > 0);
    const candidates = (visible.length > 0 ? visible : colored).toSorted(
      (left, right) => Number(right.small) - Number(left.small) || left.area - right.area,
    );
    return candidates[0]?.color;
  }

  private calendarSectionKey(row: Element): string {
    const section = row.closest<HTMLElement>('[role="group"], [aria-label]');
    return (
      section?.getAttribute("data-calendar-section") ??
      section?.getAttribute("aria-label") ??
      "calendar-list"
    );
  }

  private isCalendarVisible(control: Element): boolean {
    if (control.tagName === "INPUT") return (control as HTMLInputElement).checked;
    return control.getAttribute("aria-checked") === "true";
  }

  private eventCalendar(element: Element): CalendarSnapshot | null {
    const eventId = element.getAttribute("data-eventid") ?? element.getAttribute("data-event-id");
    const decodedCalendarId = eventId ? decodeCalendarIdFromEventId(eventId) : null;
    if (eventId && decodedCalendarId) {
      const known = this.calendars.find(
        (calendar) =>
          calendar.key === `calendar:${decodedCalendarId}` && calendar.confidence !== "weak",
      );
      if (known) {
        this.eventCalendarRefs.set(element, { eventId, calendarKey: known.key });
        return known;
      }
      return null;
    }

    const cached = this.eventCalendarRefs.get(element);
    if (eventId && cached?.eventId === eventId) {
      const known = this.calendars.find(({ key }) => key === cached.calendarKey);
      if (known && known.confidence !== "weak") return known;
    }

    const current = element.closest(
      "[data-calendar-id], [data-calendarid], [data-calendar-key], [data-calendar-name]",
    );
    if (current) {
      const id = readCalendarId(current);
      const label = current.getAttribute("data-calendar-name")?.trim();
      const known = id
        ? this.calendars.find((calendar) => calendar.key === `calendar:${id}`)
        : label
          ? resolveCalendarByLabel(label, this.calendars)
          : null;
      if (known) return known;
    }

    const label = element.getAttribute("data-calendar-name");
    const byLabel = label ? resolveCalendarByLabel(label, this.calendars) : null;
    if (byLabel) return byLabel;

    const color = this.eventColor(element);
    if (!color) return null;
    const colorMatches = this.calendars.filter(
      (calendar) =>
        calendar.confidence !== "weak" &&
        calendar.nativeColor &&
        normalizeColor(calendar.nativeColor, this.document) === color,
    );
    const calendar = colorMatches.length === 1 ? (colorMatches[0] ?? null) : null;
    if (eventId && calendar)
      this.eventCalendarRefs.set(element, { eventId, calendarKey: calendar.key });
    return calendar;
  }

  private eventColor(element: Element): string | undefined {
    const htmlElement = element as HTMLElement;
    const inline = htmlElement.style?.backgroundColor;
    if (inline) return normalizeColor(inline, this.document);
    const computed = this.document.defaultView?.getComputedStyle(htmlElement).backgroundColor;
    return computed ? normalizeColor(computed, this.document) : undefined;
  }

  private eventRef(element: Element): string {
    let ref = this.eventRefs.get(element);
    if (!ref) {
      ref = `event-${++this.nextEventRef}`;
      this.eventRefs.set(element, ref);
    }
    return ref;
  }
}

function normalizeColor(value: string, document: Document): string | undefined {
  const probe = document.createElement("span");
  probe.style.color = value;
  return probe.style.color ? probe.style.color.toLowerCase() : undefined;
}
