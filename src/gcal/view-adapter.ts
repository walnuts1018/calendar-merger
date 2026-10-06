import type { CalendarEvent, CalendarSnapshot, CalendarView } from "../domain/model";

import { createMergeKey as createDomainMergeKey } from "../domain/merge";

export type SupportedCalendarView = Exclude<CalendarView, "unknown">;

export interface MergedGeometry {
  left: string;
  width: string;
  top?: string;
  height?: string;
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
  mergeVisibilityContainer(element: HTMLElement): HTMLElement | null;
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
    return mergedGeometry(members, eventElements, this.view);
  }

  mergeVisibilityContainer(element: HTMLElement): HTMLElement | null {
    if (this.view !== "schedule") return null;
    const row = element.parentElement;
    if (
      !row ||
      row.getAttribute("role") !== "row" ||
      row.children.length !== 2 ||
      ![...row.children].some(
        (child) => child === element && child.matches("[data-eventchip][data-eventid]"),
      ) ||
      ![...row.children].some(
        (child) => child !== element && child.getAttribute("role") === "gridcell",
      ) ||
      row.querySelectorAll("[data-eventchip][data-eventid]").length !== 1
    )
      return null;
    return row;
  }

  restoreGeometry(_element: HTMLElement, restoreProperty: (property: string) => void): void {
    restoreProperty("left");
    restoreProperty("width");
    restoreProperty("top");
    restoreProperty("height");
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

  const content = `${element.getAttribute("aria-label") ?? ""}\n${element.textContent ?? ""}`;
  const quotedTitle = /[「“"]([^」”"]+)[」”"]/u.exec(content)?.[1]?.trim();
  if (quotedTitle) return quotedTitle;

  const visibleLines = (element as HTMLElement).innerText
    ?.split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (visibleLines && visibleLines.length > 1 && parseTimeRange(visibleLines[0] ?? ""))
    return visibleLines[1] ?? "";

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
  if (!startValue || !endValue)
    return semanticInterval(element, view) ?? layoutInterval(element, view);

  const start = normalizeDate(startValue);
  const end = normalizeDate(endValue);
  if (!start || !end || Date.parse(end) <= Date.parse(start))
    return semanticInterval(element, view) ?? layoutInterval(element, view);
  const dateOnlyInterval = !startValue.includes("T") && !endValue.includes("T");
  const allDay = dateOnlyInterval || hasAllDayAttribute(element);
  return { dateKey: start.slice(0, 10), start, end, allDay };
}

function semanticInterval(
  element: Element,
  view: SupportedCalendarView,
): {
  dateKey: string;
  start: string;
  end: string;
  allDay: boolean;
} | null {
  if (view === "year") return null;

  const htmlElement = element as HTMLElement;
  const content = [
    element.getAttribute("aria-label") ?? "",
    htmlElement.innerText ?? "",
    element.textContent ?? "",
  ].join("\n");
  const cell = element.closest('[role="gridcell"]');
  const cellLabel = accessibleLabel(cell, element.ownerDocument);
  const dateFromContainer = element.closest("[data-datekey]")?.getAttribute("data-datekey") ?? null;
  const dateKey =
    dateFromContainer ??
    localizedDateKey(`${cellLabel}\n${content}`) ??
    dateKeyFromMonthDay(cellLabel, element.ownerDocument, view);
  if (!dateKey) return null;

  const timeRange = parseTimeRange(content);
  if (timeRange) return { dateKey, ...timeRange, allDay: false };
  if (hasAllDaySemantics(element, cellLabel))
    return { dateKey, start: "00:00", end: "24:00", allDay: true };
  if (view === "month" && element.hasAttribute("data-stacked-layout-chip-container"))
    return { dateKey, start: "00:00", end: "24:00", allDay: true };
  return null;
}

function hasAllDaySemantics(element: Element, content: string): boolean {
  return hasAllDayAttribute(element) || /終日|all\s+day/iu.test(content);
}

function hasAllDayAttribute(element: Element): boolean {
  return (
    element.getAttribute("data-all-day") === "true" ||
    Boolean(element.closest('[data-all-day="true"]'))
  );
}

function parseTimeRange(value: string): { start: string; end: string } | null {
  const japaneseRange =
    /(午前|午後)?\s*(\d{1,2})(?::(\d{2}))?\s*時?\s*(?:～|〜|~|–|—|-|to)\s*(午前|午後)?\s*(\d{1,2})(?::(\d{2}))?\s*時?/giu;
  for (const match of value.matchAll(japaneseRange)) {
    const start = formatClock(match[2], match[3], match[1] ?? match[4]);
    const end = formatClock(match[5], match[6], match[4] ?? match[1]);
    if (start && end) return { start, end };
  }

  const englishRange =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:to|[-–—])\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/giu;
  for (const match of value.matchAll(englishRange)) {
    const start = formatClock(match[1], match[2], match[3]);
    const end = formatClock(match[4], match[5], match[6] ?? match[3]);
    if (start && end) return { start, end };
  }
  return null;
}

function formatClock(
  hourValue: string | undefined,
  minuteValue: string | undefined,
  periodValue: string | undefined,
): string | null {
  if (!hourValue) return null;
  let hour = Number(hourValue);
  const minute = Number(minuteValue ?? 0);
  const period = periodValue?.toLowerCase();
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute > 59) return null;
  if (period === "午前" || period === "am") hour = hour === 12 ? 0 : hour;
  else if (period === "午後" || period === "pm") hour = hour === 12 ? 12 : hour + 12;
  if (hour < 0 || hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function localizedDateKey(value: string): string | null {
  const japaneseDate = /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/u.exec(value);
  if (japaneseDate?.[1] && japaneseDate[2] && japaneseDate[3])
    return `${japaneseDate[1]}-${japaneseDate[2].padStart(2, "0")}-${japaneseDate[3].padStart(2, "0")}`;

  const englishDate =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/iu.exec(
      value,
    );
  if (!englishDate?.[1] || !englishDate[2] || !englishDate[3]) return null;
  const parsed = new Date(`${englishDate[1]} ${englishDate[2]}, ${englishDate[3]} UTC`);
  if (!Number.isFinite(parsed.getTime())) return null;
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

function dateKeyFromMonthDay(
  value: string,
  document: Document,
  view: SupportedCalendarView,
): string | null {
  if (view !== "day" && view !== "week") return null;
  const japaneseDate = /(?<!\d)(\d{1,2})月\s*(\d{1,2})日/u.exec(value);
  const englishDate =
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/iu.exec(
      value,
    );
  const month = japaneseDate?.[1]
    ? Number(japaneseDate[1])
    : englishDate?.[1]
      ? monthNumber(englishDate[1])
      : null;
  const day = Number(japaneseDate?.[2] ?? englishDate?.[2]);
  if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;

  const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, [role='heading']")];
  const referenceHeading =
    headings.find(
      (heading) =>
        !heading.closest("[hidden]") &&
        (view === "week" ? /週|week/iu.test(heading.textContent ?? "") : true) &&
        localizedDateKey(heading.textContent ?? "") !== null,
    ) ??
    headings.find(
      (heading) => !heading.closest("[hidden]") && localizedDateKey(heading.textContent ?? ""),
    );
  const referenceDate = referenceHeading
    ? localizedDateKey(referenceHeading.textContent ?? "")
    : null;
  if (!referenceDate) return null;

  const referenceTime = Date.parse(`${referenceDate}T12:00:00Z`);
  const referenceYear = new Date(referenceTime).getUTCFullYear();
  const searchRadius = view === "week" ? 6 : 0;
  const matches = new Set<string>();
  for (let year = referenceYear - 1; year <= referenceYear + 1; year += 1) {
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    if (Math.abs(date.getTime() - referenceTime) > searchRadius * 86_400_000) continue;
    matches.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  }
  return matches.size === 1 ? (matches.values().next().value ?? null) : null;
}

function monthNumber(value: string): number | null {
  const month = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/iu
    .exec(value)?.[1]
    ?.toLowerCase();
  if (!month) return null;
  return (
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
      month,
    ) + 1
  );
}

function accessibleLabel(element: Element | null, document: Document): string {
  if (!element) return "";
  const labels = element.getAttribute("aria-labelledby") ?? "";
  const references = labels
    .split(/\s+/u)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean);
  return [
    element.getAttribute("aria-label") ?? "",
    ...references,
    (element as HTMLElement).innerText ?? "",
  ]
    .filter(Boolean)
    .join("\n");
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
  const cell = element.closest('[role="gridcell"]');
  const cellLabel = accessibleLabel(cell, element.ownerDocument);
  if (dateKey && hasAllDaySemantics(element, cellLabel)) {
    return {
      dateKey,
      start: "00:00",
      end: "24:00",
      layoutKey: `${dateKey}:all-day`,
      allDay: true,
    };
  }
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
  view: SupportedCalendarView,
): GeometryAssessment {
  const elements = members.map((member) => eventElements.get(member.ref));
  if (elements.some((element) => !element)) return { safe: false };
  const presentElements = elements.filter((element) => element !== undefined);
  const firstElement = presentElements[0];
  if (!firstElement) return { safe: false };
  if (view === "schedule") return scheduleRowsAreCollapsible(presentElements);
  const firstWindow = firstElement.ownerDocument.defaultView;
  if (!firstWindow) return { safe: false };
  const styles = presentElements.map((element) => firstWindow.getComputedStyle(element));
  if (view === "month") {
    const stacked = monthStackGeometry(presentElements, styles);
    if (stacked) return stacked;
  }
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
      paddingTop: Number.parseFloat(style.paddingTop) || 0,
      paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
      borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
      borderRight: Number.parseFloat(style.borderRightWidth) || 0,
      borderTop: Number.parseFloat(style.borderTopWidth) || 0,
      borderBottom: Number.parseFloat(style.borderBottomWidth) || 0,
    };
  });
  if (measurements.some((measurement) => measurement === null)) return { safe: false };
  const positioned = measurements.filter((measurement) => measurement !== null);
  const first = positioned[0];
  if (!first) return { safe: false };
  const semanticInterval = members.every((member) => !member.layoutKey);
  const top = Math.min(...positioned.map((measurement) => measurement.top));
  const bottom = Math.max(...positioned.map((measurement) => measurement.top + measurement.height));
  const verticalBoundsMatch = semanticInterval
    ? Math.max(...positioned.map((measurement) => measurement.top)) - top <= 8 &&
      bottom - Math.min(...positioned.map((measurement) => measurement.top + measurement.height)) <=
        8
    : positioned.every(
        (measurement) => measurement.top === first.top && measurement.height === first.height,
      );
  if (
    positioned.some(
      (measurement) =>
        measurement.parent !== first.parent || measurement.boxSizing !== first.boxSizing,
    ) ||
    !verticalBoundsMatch
  )
    return { safe: false };

  const ordered = positioned.toSorted((left, right) => left.left - right.left);
  let right = ordered[0]?.left ?? 0;
  for (const measurement of ordered) {
    if (measurement.left > right + 8) return { safe: false };
    right = Math.max(right, measurement.left + measurement.width);
  }
  const firstLeft = ordered[0]?.left;
  if (firstLeft === undefined) return { safe: false };
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
  const height =
    first.boxSizing === "border-box"
      ? bottom - top
      : bottom -
        top -
        first.paddingTop -
        first.paddingBottom -
        first.borderTop -
        first.borderBottom;
  if (height <= 0) return { safe: false };
  return {
    safe: true,
    geometry: {
      left: `${firstLeft}px`,
      width: `${width}px`,
      top: `${top}px`,
      height: `${height}px`,
    },
  };
}

function scheduleRowsAreCollapsible(elements: readonly HTMLElement[]): GeometryAssessment {
  const rows = elements.map((element) => {
    const row = element.parentElement;
    const sibling =
      row?.children.length === 2 ? [...row.children].find((child) => child !== element) : null;
    if (
      !row ||
      row.getAttribute("role") !== "row" ||
      sibling?.getAttribute("role") !== "gridcell" ||
      row.querySelectorAll("[data-eventchip][data-eventid]").length !== 1 ||
      element.getAttribute("data-eventid") === null
    )
      return null;
    return row;
  });
  if (rows.some((row) => row === null) || new Set(rows).size !== rows.length)
    return { safe: false };
  return { safe: true };
}

function monthStackGeometry(
  elements: readonly HTMLElement[],
  styles: readonly CSSStyleDeclaration[],
): GeometryAssessment | null {
  const first = elements[0];
  const firstStyle = styles[0];
  if (!first || !firstStyle?.position || firstStyle.position !== "absolute") return null;
  const parent = first.parentElement;
  if (!parent || !first.style.left || !first.style.width) return { safe: false };

  const measurements = elements.map((element, index) => ({
    element,
    style: styles[index],
    left: element.offsetLeft,
    top: element.offsetTop,
    width: element.offsetWidth,
    height: element.offsetHeight,
  }));
  if (
    measurements.some(
      ({ element, style, left, width, height }) =>
        element.parentElement !== parent ||
        !style ||
        style.position !== "absolute" ||
        style.transform !== "none" ||
        element.offsetParent !== first.offsetParent ||
        element.style.left !== first.style.left ||
        element.style.width !== first.style.width ||
        left !== first.offsetLeft ||
        width !== first.offsetWidth ||
        height !== first.offsetHeight,
    )
  )
    return { safe: false };

  const top = Math.min(...measurements.map((measurement) => measurement.top));
  return {
    safe: true,
    geometry: {
      left: first.style.left,
      width: first.style.width,
      top: `${top}px`,
      height: first.style.height || firstStyle.height,
    },
  };
}
