import { readCalendarId } from "./identity";

export const calendarControlSelector =
  '[role="checkbox"][aria-label], input[type="checkbox"][aria-label], [role="switch"][aria-label]';

const calendarContainerSelector =
  '[role="list"], [role="tree"], [role="group"], [role="navigation"], [role="complementary"], [role="region"], nav, aside';
const calendarRowSelector = '[role="listitem"], [role="treeitem"]';
const calendarIdAttributes = ["data-calendar-id", "data-calendarid", "data-calendar-key"];
const calendarNamePattern =
  /\bcalendar(?:s)?\b|カレンダー|予定表|calendario|calendários?|calendrier|kalender|kalendar|календар/iu;

export function findCalendarListRoot(document: Document): HTMLElement | null {
  const containers = [...document.querySelectorAll<HTMLElement>(calendarContainerSelector)].filter(
    (container) => !container.closest("[data-gce-ui], [data-gce-overlay]"),
  );
  const namedSections = containers.filter(
    (container) =>
      calendarNamePattern.test(accessibleName(container, document)) &&
      collectCalendarRows(container).length > 0,
  );

  const roots =
    namedSections.length > 0
      ? findRootsForNamedSections(containers, namedSections, document)
      : findRootsForUnlabelledSections(containers, document);
  if (roots.length === 0) return null;

  const mostSpecific = roots.filter(
    (root) => !roots.some((candidate) => candidate !== root && root.contains(candidate)),
  );
  return mostSpecific.length === 1 ? (mostSpecific[0] ?? null) : null;
}

function findRootsForNamedSections(
  containers: readonly HTMLElement[],
  namedSections: readonly HTMLElement[],
  document: Document,
): HTMLElement[] {
  const sections = removeRedundantSections(namedSections);
  const expectedRows = new Set(sections.flatMap((section) => collectCalendarRows(section)));
  if (expectedRows.size === 0) return [];

  return containers.filter((container) => {
    if (!sections.every((section) => container === section || container.contains(section)))
      return false;
    const rows = collectCalendarRows(container);
    if (![...expectedRows].every((row) => rows.includes(row))) return false;

    const hasCalendarName = calendarNamePattern.test(accessibleName(container, document));
    return hasCalendarName || (sections.length > 1 && isListRoot(container));
  });
}

function findRootsForUnlabelledSections(
  containers: readonly HTMLElement[],
  document: Document,
): HTMLElement[] {
  const expectedRows = collectCalendarRows(document.body ?? document.documentElement, true);
  if (expectedRows.length === 0) return [];
  const controls = [...document.querySelectorAll<HTMLElement>(calendarControlSelector)].filter(
    (control) => !control.closest("[data-gce-ui], [data-gce-overlay]"),
  );
  if (
    controls.some((control) => {
      const row = control.closest<HTMLElement>(calendarRowSelector);
      return !row || !hasCalendarIdentity(row);
    })
  )
    return [];

  return containers.filter((container) => {
    if (!isListRoot(container)) return false;
    const rows = collectCalendarRows(container);
    return expectedRows.every((row) => rows.includes(row));
  });
}

function removeRedundantSections(sections: readonly HTMLElement[]): HTMLElement[] {
  return sections.filter((section) => {
    const rows = collectCalendarRows(section);
    return !sections.some((candidate) => {
      if (candidate === section || !section.contains(candidate)) return false;
      const candidateRows = collectCalendarRows(candidate);
      return sameRows(rows, candidateRows);
    });
  });
}

function sameRows(left: readonly HTMLElement[], right: readonly HTMLElement[]): boolean {
  return left.length === right.length && left.every((row) => right.includes(row));
}

function collectCalendarRows(container: ParentNode, requireStableIdentity = false): HTMLElement[] {
  const rows = new Set<HTMLElement>();
  for (const control of container.querySelectorAll<HTMLElement>(calendarControlSelector)) {
    if (control.closest("[data-gce-ui], [data-gce-overlay]")) continue;
    const row = control.closest<HTMLElement>(calendarRowSelector);
    if (!row || row.closest("[data-gce-ui], [data-gce-overlay]")) continue;
    if (requireStableIdentity && !hasCalendarIdentity(row)) continue;
    rows.add(row);
  }
  return [...rows];
}

function hasCalendarIdentity(row: Element): boolean {
  const id = readCalendarId(row);
  return Boolean(id && (hasExplicitCalendarId(row) || id.includes("@")));
}

function hasExplicitCalendarId(row: Element): boolean {
  return calendarIdAttributes.some((attribute) => Boolean(row.getAttribute(attribute)?.trim()));
}

function accessibleName(element: Element, document: Document): string {
  const label = element.getAttribute("aria-label")?.trim();
  if (label) return label;
  const labelledBy = element.getAttribute("aria-labelledby")?.trim();
  if (!labelledBy) return "";
  return labelledBy
    .split(/\s+/u)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

function isListRoot(element: HTMLElement): boolean {
  const role = element.getAttribute("role");
  return (
    role === "list" ||
    role === "tree" ||
    role === "group" ||
    role === "navigation" ||
    role === "complementary" ||
    role === "region" ||
    element.tagName === "NAV" ||
    element.tagName === "ASIDE"
  );
}
