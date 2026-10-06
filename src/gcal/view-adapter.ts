import type { CalendarEvent, CalendarSnapshot, CalendarView } from "../domain/model";

import { createMergeKey as createDomainMergeKey } from "../domain/merge";

export type SupportedCalendarView = Exclude<CalendarView, "unknown">;

export interface MergedGeometry {
  left: string;
  width: string;
}

export type GeometryAssessment = { safe: true; geometry?: MergedGeometry } | { safe: false };

export interface EventExtractionContext {
  resolveCalendar(element: Element): CalendarSnapshot | null;
  getEventRef(element: Element): string;
}

export interface CalendarViewAdapter {
  readonly view: SupportedCalendarView;
  extractEvent(
    element: Element,
    domOrder: number,
    context: EventExtractionContext,
  ): CalendarEvent | null;
  createMergeKey(event: CalendarEvent): string | null;
  applyMergedGeometry(
    members: readonly CalendarEvent[],
    eventElements: ReadonlyMap<string, HTMLElement>,
  ): GeometryAssessment;
  restoreGeometry(element: HTMLElement, restoreProperty: (property: string) => void): void;
}

class SemanticCalendarViewAdapter implements CalendarViewAdapter {
  constructor(readonly view: SupportedCalendarView) {}

  extractEvent(
    element: Element,
    domOrder: number,
    context: EventExtractionContext,
  ): CalendarEvent | null {
    if (element.closest("[hidden]")) return null;
    const title = eventTitle(element);
    const interval = eventInterval(element, this.view);
    const calendar = context.resolveCalendar(element);
    if (!title || !interval || !calendar) return null;

    return {
      ref: context.getEventRef(element),
      calendarKey: calendar.key,
      calendarConfidence: calendar.confidence,
      eventConfidence: eventIdentityConfidence(element),
      ownership: calendar.ownership,
      title,
      dateKey: interval.dateKey,
      start: interval.start,
      end: interval.end,
      ...(interval.layoutKey ? { layoutKey: interval.layoutKey } : {}),
      allDay: interval.allDay,
      view: this.view,
      domOrder,
      ...(calendar.nativeColor ? { nativeColor: calendar.nativeColor } : {}),
    };
  }

  createMergeKey(event: CalendarEvent): string | null {
    return event.view === this.view ? createDomainMergeKey(event) : null;
  }

  applyMergedGeometry(
    members: readonly CalendarEvent[],
    eventElements: ReadonlyMap<string, HTMLElement>,
  ): GeometryAssessment {
    if (members.some((member) => member.view !== this.view)) return { safe: false };
    return mergedGeometry(members, eventElements);
  }

  restoreGeometry(_element: HTMLElement, restoreProperty: (property: string) => void): void {
    restoreProperty("left");
    restoreProperty("width");
  }
}

const supportedViews: readonly SupportedCalendarView[] = [
  "day",
  "week",
  "month",
  "schedule",
  "year",
];

export function createCalendarViewAdapters(): ReadonlyMap<CalendarView, CalendarViewAdapter> {
  return new Map(supportedViews.map((view) => [view, new SemanticCalendarViewAdapter(view)]));
}

function eventTitle(element: Element): string {
  const direct = element.getAttribute("data-event-title") ?? element.getAttribute("title");
  if (direct?.trim()) return direct.trim();
  const child = element.querySelector<HTMLElement>(
    "[data-event-title], time[datetime][data-title]",
  );
  const childTitle =
    child?.getAttribute("data-event-title") ??
    child?.getAttribute("data-title") ??
    child?.textContent;
  if (childTitle?.trim()) return childTitle.trim().replace(/\s+/gu, " ");

  const visibleContent = element.querySelector<HTMLElement>('[aria-hidden="true"]');
  const visibleTitleElement =
    visibleContent?.firstElementChild?.firstElementChild ?? visibleContent?.firstElementChild;
  const visibleTitle =
    visibleTitleElement?.textContent?.trim() ??
    visibleContent?.innerText
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  if (visibleTitle) return visibleTitle;
  return element.getAttribute("aria-label")?.trim() ?? "";
}

function eventInterval(
  element: Element,
  view: SupportedCalendarView,
): {
  dateKey: string;
  start: string;
  end: string;
  layoutKey?: string;
  allDay: boolean;
} | null {
  const times = element.querySelectorAll("time[datetime]");
  const startValue = element.getAttribute("data-start") ?? times[0]?.getAttribute("datetime");
  const endValue = element.getAttribute("data-end") ?? times[1]?.getAttribute("datetime");
  if (!startValue || !endValue) return layoutInterval(element, view);

  const start = normalizeDate(startValue);
  const end = normalizeDate(endValue);
  if (!start || !end || Date.parse(end) <= Date.parse(start)) return layoutInterval(element, view);
  const dateOnlyInterval = !startValue.includes("T") && !endValue.includes("T");
  const allDay = element.getAttribute("data-all-day") === "true" || dateOnlyInterval;
  return { dateKey: start.slice(0, 10), start, end, allDay };
}

function layoutInterval(
  element: Element,
  view: SupportedCalendarView,
): {
  dateKey: string;
  start: string;
  end: string;
  layoutKey: string;
  allDay: boolean;
} | null {
  if (view !== "day" && view !== "week") return null;
  const dateKey = element.closest('[role="gridcell"][data-datekey]')?.getAttribute("data-datekey");
  const htmlElement = element as HTMLElement;
  const top = pixelValue(htmlElement.style.top);
  const height = pixelValue(htmlElement.style.height);
  if (!dateKey || top === null || height === null || height <= 0) return null;
  return {
    dateKey,
    start: "",
    end: "",
    layoutKey: `${dateKey}:${top}:${height}`,
    allDay: false,
  };
}

function pixelValue(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)px$/u.exec(value.trim());
  if (!match?.[1]) return null;
  const number = Number(match[1]);
  return Number.isFinite(number) ? number : null;
}

function normalizeDate(value: string): string | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function eventIdentityConfidence(element: Element): CalendarEvent["eventConfidence"] {
  if (element.hasAttribute("data-eventid") || element.hasAttribute("data-event-id"))
    return "strong";
  if (
    (element.hasAttribute("data-gce-event") || element.hasAttribute("data-start")) &&
    element.getAttribute("role") === "button" &&
    element.hasAttribute("aria-label")
  )
    return "medium";
  return "weak";
}

function mergedGeometry(
  members: readonly CalendarEvent[],
  eventElements: ReadonlyMap<string, HTMLElement>,
): GeometryAssessment {
  const elements = members.map((member) => eventElements.get(member.ref));
  if (elements.some((element) => !element)) return { safe: false };
  const presentElements = elements.filter((element) => element !== undefined);
  const firstElement = presentElements[0];
  if (!firstElement) return { safe: false };
  const firstWindow = firstElement.ownerDocument.defaultView;
  if (!firstWindow) return { safe: false };
  const styles = presentElements.map((element) => firstWindow.getComputedStyle(element));
  const firstParent = firstElement.parentElement;
  const flowLayoutIsFullWidth =
    firstParent !== null &&
    firstParent.clientWidth > 0 &&
    presentElements.every(
      (element, index) =>
        element.parentElement === firstParent &&
        styles[index]?.position === "static" &&
        styles[index]?.display === "block" &&
        element.offsetWidth >= firstParent.clientWidth * 0.92,
    );
  if (flowLayoutIsFullWidth) return { safe: true };
  if (styles.some((style) => style.position !== "absolute")) return { safe: false };

  const measurements = presentElements.map((element, index) => {
    const style = styles[index];
    const explicitLeft = element.style.getPropertyValue("left");
    const explicitRight = element.style.getPropertyValue("right");
    if (
      !style ||
      !element.offsetParent ||
      style.transform !== "none" ||
      !explicitLeft ||
      explicitLeft === "auto" ||
      (explicitRight !== "" && explicitRight !== "auto")
    )
      return null;
    return {
      parent: element.offsetParent,
      left: element.offsetLeft,
      top: element.offsetTop,
      width: element.offsetWidth,
      height: element.offsetHeight,
      boxSizing: style.boxSizing,
      paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
      paddingRight: Number.parseFloat(style.paddingRight) || 0,
      borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
      borderRight: Number.parseFloat(style.borderRightWidth) || 0,
    };
  });
  if (measurements.some((measurement) => measurement === null)) return { safe: false };
  const positioned = measurements.filter((measurement) => measurement !== null);
  const first = positioned[0];
  if (!first) return { safe: false };
  if (
    positioned.some(
      (measurement) =>
        measurement.parent !== first.parent ||
        measurement.top !== first.top ||
        measurement.height !== first.height ||
        measurement.boxSizing !== first.boxSizing,
    )
  )
    return { safe: false };

  const ordered = positioned.toSorted((left, right) => left.left - right.left);
  let right = ordered[0]?.left ?? 0;
  let maximumSingleWidth = 0;
  for (const measurement of ordered) {
    if (measurement.left > right + 8) return { safe: false };
    right = Math.max(right, measurement.left + measurement.width);
    maximumSingleWidth = Math.max(maximumSingleWidth, measurement.width);
  }
  const firstLeft = ordered[0]?.left;
  if (firstLeft === undefined) return { safe: false };
  if (right - firstLeft <= maximumSingleWidth) return { safe: true };
  const width =
    first.boxSizing === "border-box"
      ? right - firstLeft
      : right -
        firstLeft -
        first.paddingLeft -
        first.paddingRight -
        first.borderLeft -
        first.borderRight;
  if (width <= 0) return { safe: false };
  return { safe: true, geometry: { left: `${firstLeft}px`, width: `${width}px` } };
}
