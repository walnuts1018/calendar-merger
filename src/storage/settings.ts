import type { CalendarGroup, CalendarPreferences, VisibilityProfile } from "../domain/model";

export interface Settings {
  schemaVersion: 1;
  mergeEnabled: boolean;
  calendars: Record<string, CalendarPreferences>;
  groups: Record<string, CalendarGroup>;
  profiles: Record<string, VisibilityProfile>;
}

export const settingsStorageKey = "calendar-merger.settings";

export function createDefaultSettings(): Settings {
  return { schemaVersion: 1, mergeEnabled: true, calendars: {}, groups: {}, profiles: {} };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0),
    ),
  ];
}

function validColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/iu.test(value);
}

function isSafeKey(value: string): boolean {
  return value !== "__proto__" && value !== "constructor" && value !== "prototype";
}

function normalizeCalendars(value: unknown): Record<string, CalendarPreferences> {
  const source = record(value);
  const calendars: Record<string, CalendarPreferences> = {};
  if (!source) return calendars;

  for (const [key, rawPreferences] of Object.entries(source)) {
    if (!isSafeKey(key)) continue;
    const preferences = record(rawPreferences);
    if (!preferences) continue;
    const opacity =
      typeof preferences.opacity === "number" && Number.isFinite(preferences.opacity)
        ? Math.min(1, Math.max(0, preferences.opacity))
        : 1;
    const normalized: CalendarPreferences = { opacity };
    if (validColor(preferences.color)) normalized.color = preferences.color.toLowerCase();
    if (typeof preferences.groupId === "string" && preferences.groupId.length > 0) {
      normalized.groupId = preferences.groupId;
    }
    calendars[key] = normalized;
  }

  return calendars;
}

function normalizeGroups(
  value: unknown,
  calendars: Record<string, CalendarPreferences>,
): Record<string, CalendarGroup> {
  const source = record(value);
  const groups: Record<string, CalendarGroup> = {};
  if (!source) return groups;

  for (const [id, rawGroup] of Object.entries(source)) {
    if (!isSafeKey(id)) continue;
    const group = record(rawGroup);
    if (!group || typeof group.name !== "string" || group.name.trim() === "") continue;
    groups[id] = { id, name: group.name.trim(), calendarKeys: stringArray(group.calendarKeys) };
  }

  for (const preferences of Object.values(calendars)) {
    if (preferences.groupId && !groups[preferences.groupId]) delete preferences.groupId;
  }
  return groups;
}

function normalizeProfiles(value: unknown): Record<string, VisibilityProfile> {
  const source = record(value);
  const profiles: Record<string, VisibilityProfile> = {};
  if (!source) return profiles;

  for (const [id, rawProfile] of Object.entries(source)) {
    if (!isSafeKey(id)) continue;
    const profile = record(rawProfile);
    if (!profile || typeof profile.name !== "string" || profile.name.trim() === "") continue;
    profiles[id] = {
      id,
      name: profile.name.trim(),
      visibleCalendarKeys: stringArray(profile.visibleCalendarKeys),
    };
  }

  return profiles;
}

export function migrateSettings(raw: unknown): Settings {
  const source = record(raw);
  if (!source) return createDefaultSettings();

  const calendars = normalizeCalendars(source.calendars);
  const schemaVersion = source.schemaVersion;
  if (schemaVersion !== undefined && schemaVersion !== 0 && schemaVersion !== 1) {
    return createDefaultSettings();
  }

  return {
    schemaVersion: 1,
    mergeEnabled: typeof source.mergeEnabled === "boolean" ? source.mergeEnabled : true,
    calendars,
    groups: normalizeGroups(source.groups, calendars),
    profiles: normalizeProfiles(source.profiles),
  };
}

export interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export class SettingsRepository {
  constructor(private readonly storage: LocalStorageArea) {}

  async load(): Promise<Settings> {
    const stored = await this.storage.get(settingsStorageKey);
    const settings = migrateSettings(stored[settingsStorageKey]);
    await this.storage.set({ [settingsStorageKey]: settings });
    return settings;
  }

  async save(settings: Settings): Promise<void> {
    await this.storage.set({ [settingsStorageKey]: migrateSettings(settings) });
  }
}
