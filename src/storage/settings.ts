import type { CalendarGroup, CalendarPreferences, VisibilityProfile } from "../domain/model";

export interface Settings {
  schemaVersion: 2;
  mergeEnabled: boolean;
  calendars: Record<string, CalendarPreferences>;
  groups: Record<string, CalendarGroup>;
  profiles: Record<string, VisibilityProfile>;
}

export const settingsStorageKey = "calendar-merger.settings";
const calendarSettingsStoragePrefix = `${settingsStorageKey}.calendar.`;

export function createDefaultSettings(): Settings {
  return { schemaVersion: 2, mergeEnabled: true, calendars: {}, groups: {}, profiles: {} };
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

function normalizeGroups(value: unknown): Record<string, CalendarGroup> {
  const source = record(value);
  const groups: Record<string, CalendarGroup> = {};
  if (!source) return groups;

  for (const [id, rawGroup] of Object.entries(source)) {
    if (!isSafeKey(id)) continue;
    const group = record(rawGroup);
    if (!group || typeof group.name !== "string" || group.name.trim() === "") continue;
    groups[id] = { id, name: group.name.trim() };
  }
  return groups;
}

function migrateLegacyGroupMembership(
  source: unknown,
  calendars: Record<string, CalendarPreferences>,
  groups: Record<string, CalendarGroup>,
): void {
  const legacyGroups = record(source);
  if (!legacyGroups) return;

  for (const [groupId, rawGroup] of Object.entries(legacyGroups)) {
    if (!Object.hasOwn(groups, groupId)) continue;
    const group = record(rawGroup);
    for (const calendarKey of stringArray(group?.calendarKeys)) {
      const preferences = calendars[calendarKey];
      if (preferences && !Object.hasOwn(groups, preferences.groupId ?? ""))
        preferences.groupId = groupId;
    }
  }
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

  const schemaVersion = source.schemaVersion;
  if (
    schemaVersion !== undefined &&
    schemaVersion !== 0 &&
    schemaVersion !== 1 &&
    schemaVersion !== 2
  ) {
    return createDefaultSettings();
  }
  const calendars = normalizeCalendars(source.calendars);
  const groups = normalizeGroups(source.groups);
  if (schemaVersion !== 2) migrateLegacyGroupMembership(source.groups, calendars, groups);
  for (const preferences of Object.values(calendars)) {
    if (preferences.groupId && !Object.hasOwn(groups, preferences.groupId))
      delete preferences.groupId;
  }

  return {
    schemaVersion: 2,
    mergeEnabled: typeof source.mergeEnabled === "boolean" ? source.mergeEnabled : true,
    calendars,
    groups,
    profiles: normalizeProfiles(source.profiles),
  };
}

export interface LocalStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface StorageChangeEvent {
  addListener(listener: StorageChangeListener): void;
  removeListener(listener: StorageChangeListener): void;
}

export type StorageChangeListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

export function calendarSettingsStorageKey(calendarKey: string): string {
  return `${calendarSettingsStoragePrefix}${encodeURIComponent(calendarKey)}`;
}

export function calendarKeyFromSettingsStorageKey(storageKey: string): string | null {
  if (!storageKey.startsWith(calendarSettingsStoragePrefix)) return null;
  try {
    const calendarKey = decodeURIComponent(storageKey.slice(calendarSettingsStoragePrefix.length));
    return calendarKey.length > 0 ? calendarKey : null;
  } catch {
    return null;
  }
}

export function isSettingsStorageKey(storageKey: string): boolean {
  return (
    storageKey === settingsStorageKey || calendarKeyFromSettingsStorageKey(storageKey) !== null
  );
}

export class SettingsRepository {
  private settings = createDefaultSettings();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: LocalStorageArea) {}

  load(calendarKeys: readonly string[] = []): Promise<Settings> {
    return this.enqueue(async () => {
      const stored = await this.storage.get(settingsStorageKey);
      const settings = migrateSettings(stored[settingsStorageKey]);
      for (const calendarKey of new Set(calendarKeys)) {
        const preferenceKey = calendarSettingsStorageKey(calendarKey);
        const preference = await this.storage.get(preferenceKey);
        if (Object.hasOwn(preference, preferenceKey))
          applyCalendarPreference(settings, calendarKey, preference[preferenceKey]);
      }
      this.settings = migrateSettings(settings);
      return migrateSettings(this.settings);
    });
  }

  loadCalendarSettings(calendarKeys: readonly string[]): Promise<Settings> {
    return this.enqueue(async () => {
      for (const calendarKey of new Set(calendarKeys)) {
        const preferenceKey = calendarSettingsStorageKey(calendarKey);
        const preference = await this.storage.get(preferenceKey);
        if (Object.hasOwn(preference, preferenceKey))
          applyCalendarPreference(this.settings, calendarKey, preference[preferenceKey]);
      }
      return migrateSettings(this.settings);
    });
  }

  refreshChangedKeys(storageKeys: readonly string[]): Promise<Settings> {
    return this.enqueue(async () => {
      if (storageKeys.includes(settingsStorageKey)) {
        const stored = await this.storage.get(settingsStorageKey);
        const external = migrateSettings(stored[settingsStorageKey]);
        this.settings = {
          ...this.settings,
          mergeEnabled: external.mergeEnabled,
          groups: external.groups,
          profiles: external.profiles,
        };
      }

      for (const storageKey of new Set(storageKeys)) {
        const calendarKey = calendarKeyFromSettingsStorageKey(storageKey);
        if (!calendarKey) continue;
        const stored = await this.storage.get(storageKey);
        if (Object.hasOwn(stored, storageKey))
          applyCalendarPreference(this.settings, calendarKey, stored[storageKey]);
      }
      this.settings = migrateSettings(this.settings);
      return migrateSettings(this.settings);
    });
  }

  save(settings: Settings): Promise<void> {
    const next = migrateSettings(settings);
    return this.enqueue(async () => {
      const changedCalendarKeys = new Set([
        ...Object.keys(this.settings.calendars),
        ...Object.keys(next.calendars),
      ]);
      for (const calendarKey of changedCalendarKeys) {
        if (sameValue(this.settings.calendars[calendarKey], next.calendars[calendarKey]))
          changedCalendarKeys.delete(calendarKey);
      }

      const globalChanged = !sameValue(globalSettings(this.settings), globalSettings(next));
      if (changedCalendarKeys.size === 0 && !globalChanged) return;

      const writes: Record<string, unknown> = {};
      const mergedLegacyCalendars = { ...this.settings.calendars };
      for (const calendarKey of changedCalendarKeys) {
        const preferences = next.calendars[calendarKey];
        writes[calendarSettingsStorageKey(calendarKey)] = {
          schemaVersion: next.schemaVersion,
          preferences: preferences ?? null,
        };
        if (preferences) mergedLegacyCalendars[calendarKey] = preferences;
        else delete mergedLegacyCalendars[calendarKey];
      }

      if (globalChanged) {
        writes[settingsStorageKey] = {
          ...next,
          calendars: mergedLegacyCalendars,
        } satisfies Settings;
      }

      await this.storage.set(writes);

      const updated = migrateSettings(this.settings);
      for (const calendarKey of changedCalendarKeys) {
        const preferences = next.calendars[calendarKey];
        if (preferences) updated.calendars[calendarKey] = preferences;
        else delete updated.calendars[calendarKey];
      }
      if (globalChanged) {
        updated.mergeEnabled = next.mergeEnabled;
        updated.groups = next.groups;
        updated.profiles = next.profiles;
      }
      this.settings = migrateSettings(updated);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function globalSettings(settings: Settings): Omit<Settings, "calendars"> {
  return {
    schemaVersion: settings.schemaVersion,
    mergeEnabled: settings.mergeEnabled,
    groups: settings.groups,
    profiles: settings.profiles,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function applyCalendarPreference(
  settings: Settings,
  calendarKey: string,
  rawPreference: unknown,
): void {
  const stored = record(rawPreference);
  if (stored && Object.hasOwn(stored, "schemaVersion")) {
    if (stored.schemaVersion !== settings.schemaVersion || !Object.hasOwn(stored, "preferences")) {
      delete settings.calendars[calendarKey];
      return;
    }
    rawPreference = stored.preferences;
  }
  if (rawPreference === null) {
    delete settings.calendars[calendarKey];
    return;
  }
  const migrated = migrateSettings({
    schemaVersion: settings.schemaVersion,
    mergeEnabled: settings.mergeEnabled,
    calendars: { [calendarKey]: rawPreference },
    groups: settings.groups,
    profiles: settings.profiles,
  });
  const preferences = migrated.calendars[calendarKey];
  if (preferences) settings.calendars[calendarKey] = preferences;
  else delete settings.calendars[calendarKey];
}
