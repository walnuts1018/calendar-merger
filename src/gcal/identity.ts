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

  for (const node of [element, ...element.querySelectorAll("[data-id]")]) {
    const value = decodeBase64Url(node.getAttribute("data-id") ?? "");
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

function decodeBase64Url(value: string): string | null {
  if (!/^[\da-z_-]+$/iu.test(value)) return null;
  try {
    const base64 = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    let containsControlCharacter = false;
    for (let index = 0; index < decoded.length; index += 1) {
      const code = decoded.charCodeAt(index);
      if (code <= 0x1f || code === 0x7f) {
        containsControlCharacter = true;
        break;
      }
    }
    return decoded && !containsControlCharacter ? decoded : null;
  } catch {
    return null;
  }
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
