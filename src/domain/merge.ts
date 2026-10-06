import type { CalendarEvent, MergeGroup } from "./model";

const privateTitles = new Set(["busy", "private", "予定あり"]);

function ownershipRank(ownership: CalendarEvent["ownership"]): number {
  return ownership === "mine" ? 0 : ownership === "other" ? 1 : 2;
}

export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

export function createMergeKey(event: CalendarEvent): string | null {
  const title = normalizeTitle(event.title);
  if (
    !title ||
    privateTitles.has(title.toLowerCase()) ||
    /^(?:busy|private|予定あり)(?:$|[\s,、:：])/iu.test(title) ||
    event.view === "unknown" ||
    !event.dateKey ||
    !event.start ||
    !event.end ||
    event.calendarConfidence === "weak" ||
    event.eventConfidence === "weak"
  ) {
    return null;
  }

  return JSON.stringify([event.view, event.dateKey, event.start, event.end, event.allDay, title]);
}

export function chooseCanonicalEvent(events: readonly CalendarEvent[]): CalendarEvent | null {
  let canonical: CalendarEvent | null = null;
  for (const event of events) {
    if (!canonical) {
      canonical = event;
      continue;
    }
    const rankDelta = ownershipRank(event.ownership) - ownershipRank(canonical.ownership);
    if (
      rankDelta < 0 ||
      (rankDelta === 0 &&
        (event.domOrder < canonical.domOrder ||
          (event.domOrder === canonical.domOrder && event.ref.localeCompare(canonical.ref) < 0)))
    ) {
      canonical = event;
    }
  }
  return canonical;
}

export function groupMergeCandidates(
  events: readonly CalendarEvent[],
  getMergeKey: (event: CalendarEvent) => string | null = createMergeKey,
): MergeGroup[] {
  const candidates = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    const key = getMergeKey(event);
    if (!key) continue;
    const bucket = candidates.get(key);
    if (bucket) bucket.push(event);
    else candidates.set(key, [event]);
  }

  const groups: MergeGroup[] = [];
  for (const [key, members] of candidates) {
    const calendarKeys = members.map(({ calendarKey }) => calendarKey);
    if (new Set(calendarKeys).size !== members.length) continue;

    const canonical = chooseCanonicalEvent(members);
    if (!canonical || members.length < 2) continue;
    groups.push({ key, canonical, members, calendarKeys });
  }

  return groups;
}
