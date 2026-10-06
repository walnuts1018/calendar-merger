import type { CalendarSnapshot, Confidence, CalendarOwnership } from "../domain/model";

const calendarIdAttributes = ["data-calendar-id", "data-calendarid", "data-calendar-key"];

export function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function readCalendarId(element: Element): string | null {
  for (const attribute of calendarIdAttributes) {
    const value = element.getAttribute(attribute)?.trim();
    if (value) return value;
  }

  for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const url = new URL(link.href, "https://calendar.google.com/");
      const value = url.searchParams.get("src") ?? url.searchParams.get("cid");
      if (value) return value;
    } catch {
      continue;
    }
  }

  return null;
}

export function calendarConfidence(element: Element, label: string, unique: boolean): Confidence {
  if (readCalendarId(element)) return "strong";
  if (unique && label && element.closest('[role="listitem"], [role="treeitem"]')) return "medium";
  return "weak";
}

export function calendarOwnership(element: Element): CalendarOwnership {
  const owner = element.getAttribute("data-calendar-owner")?.toLowerCase();
  if (owner === "mine" || owner === "self") return "mine";
  if (owner === "other" || owner === "shared") return "other";
  return "unknown";
}

export function calendarFallbackKey(label: string, section: string): string {
  return `fallback:${stableHash(`${section}\u0000${label}`)}`;
}

export function resolveCalendarByLabel(
  label: string,
  calendars: readonly CalendarSnapshot[],
): CalendarSnapshot | null {
  const matches = calendars.filter((calendar) => calendar.label === label);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
