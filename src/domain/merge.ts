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
    (!event.layoutKey && (!event.start || !event.end)) ||
    event.calendarConfidence === "weak" ||
    event.eventConfidence === "weak"
  ) {
    return null;
  }

  return JSON.stringify([
    event.view,
    event.dateKey,
    event.layoutKey ?? [event.start, event.end, event.allDay],
    title,
  ]);
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
  const candidates = new Map<string, Map<string, CalendarEvent[]>>();

  for (const event of events) {
    const key = getMergeKey(event);
    if (!key) continue;
    let calendars = candidates.get(key);
    if (!calendars) {
      calendars = new Map();
      candidates.set(key, calendars);
    }
    let occurrences = calendars.get(event.calendarKey);
    if (!occurrences) {
      occurrences = [];
      calendars.set(event.calendarKey, occurrences);
    }
    occurrences.push(event);
  }

  const groups: MergeGroup[] = [];
  for (const [candidateKey, calendars] of candidates) {
    const occurrencesByCalendar = [...calendars.values()].map((occurrences) =>
      occurrences.toSorted(
        (left, right) => left.domOrder - right.domOrder || left.ref.localeCompare(right.ref),
      ),
    );
    const occurrenceCount = Math.max(...occurrencesByCalendar.map(({ length }) => length));
    for (let occurrence = 0; occurrence < occurrenceCount; occurrence += 1) {
      const members = occurrencesByCalendar
        .map((items) => items[occurrence])
        .filter((event): event is CalendarEvent => event !== undefined);
      if (members.length < 2) continue;

      const canonical = chooseCanonicalEvent(members);
      if (!canonical) continue;
      groups.push({
        key: JSON.stringify([candidateKey, occurrence]),
        canonical,
        members,
        calendarKeys: members.map(({ calendarKey }) => calendarKey),
      });
    }
  }

  return groups;
}
