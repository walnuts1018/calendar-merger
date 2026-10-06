import type { CalendarGroup, CalendarPreferences, VisibilityProfile } from "../domain/model";

export interface Settings {
  schemaVersion: 2;
  mergeEnabled: boolean;
  calendars: Record<string, CalendarPreferences>;
  groups: Record<string, CalendarGroup>;
  profiles: Record<string, VisibilityProfile>;
}

export const settingsStorageKey = "calendar-merger.settings";
export const globalSettingsStorageKey = `${settingsStorageKey}.global`;
const calendarSettingsStoragePrefix = `${settingsStorageKey}.calendar.`;
const groupSettingsStoragePrefix = `${settingsStorageKey}.group.`;
const profileSettingsStoragePrefix = `${settingsStorageKey}.profile.`;

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
  get(key?: string | null): Promise<Record<string, unknown>>;
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
  return decodeStorageKey(storageKey, calendarSettingsStoragePrefix);
}

export function groupSettingsStorageKey(groupId: string): string {
  return `${groupSettingsStoragePrefix}${encodeURIComponent(groupId)}`;
}

export function groupIdFromSettingsStorageKey(storageKey: string): string | null {
  return decodeStorageKey(storageKey, groupSettingsStoragePrefix);
}

export function profileSettingsStorageKey(profileId: string): string {
  return `${profileSettingsStoragePrefix}${encodeURIComponent(profileId)}`;
}

export function profileIdFromSettingsStorageKey(storageKey: string): string | null {
  return decodeStorageKey(storageKey, profileSettingsStoragePrefix);
}

export type SettingsStorageKeyKind = "legacy" | "global" | "calendar" | "group" | "profile";

export function settingsStorageKeyKind(storageKey: string): SettingsStorageKeyKind | null {
  if (storageKey === settingsStorageKey) return "legacy";
  if (storageKey === globalSettingsStorageKey) return "global";
  if (calendarKeyFromSettingsStorageKey(storageKey) !== null) return "calendar";
  if (groupIdFromSettingsStorageKey(storageKey) !== null) return "group";
  if (profileIdFromSettingsStorageKey(storageKey) !== null) return "profile";
  return null;
}

export function isSettingsStorageKey(storageKey: string): boolean {
  return settingsStorageKeyKind(storageKey) !== null;
}

export class SettingsRepository {
  private settings = createDefaultSettings();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: LocalStorageArea) {}

  load(calendarKeys: readonly string[] = []): Promise<Settings> {
    return this.enqueue(async () => {
      const stored = await this.storage.get(null);
      const settings = settingsFromStorage(stored, new Set(calendarKeys));
      this.settings = migrateSettings(settings);
      return migrateSettings(this.settings);
    });
  }

  loadCalendarSettings(calendarKeys: readonly string[]): Promise<Settings> {
    return this.enqueue(async () => {
      const stored = await this.storage.get(null);
      for (const calendarKey of new Set(calendarKeys)) {
        const preferenceKey = calendarSettingsStorageKey(calendarKey);
        if (Object.hasOwn(stored, preferenceKey))
          applyCalendarPreference(this.settings, calendarKey, stored[preferenceKey]);
      }
      return migrateSettings(this.settings);
    });
  }

  refreshChangedKeys(storageKeys: readonly string[]): Promise<Settings> {
    return this.enqueue(async () => {
      const stored = await this.storage.get(null);
      const external = settingsFromStorage(stored);
      const kinds = new Set(storageKeys.map(settingsStorageKeyKind));
      if (kinds.has("legacy") || kinds.has("global"))
        this.settings.mergeEnabled = external.mergeEnabled;
      if (kinds.has("legacy") || kinds.has("group")) this.settings.groups = external.groups;
      if (kinds.has("legacy") || kinds.has("profile")) this.settings.profiles = external.profiles;
      if (kinds.has("legacy")) this.settings.calendars = external.calendars;

      for (const storageKey of new Set(storageKeys)) {
        const calendarKey = calendarKeyFromSettingsStorageKey(storageKey);
        if (!calendarKey) continue;
        if (Object.hasOwn(stored, storageKey))
          applyCalendarPreference(this.settings, calendarKey, stored[storageKey]);
        else delete this.settings.calendars[calendarKey];
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

      const changedGroupIds = changedRecordIds(this.settings.groups, next.groups);
      const changedProfileIds = changedRecordIds(this.settings.profiles, next.profiles);
      const mergeEnabledChanged = this.settings.mergeEnabled !== next.mergeEnabled;
      if (
        changedCalendarKeys.size === 0 &&
        changedGroupIds.size === 0 &&
        changedProfileIds.size === 0 &&
        !mergeEnabledChanged
      )
        return;

      const writes: Record<string, unknown> = {};
      for (const calendarKey of changedCalendarKeys) {
        const preferences = next.calendars[calendarKey];
        writes[calendarSettingsStorageKey(calendarKey)] = {
          schemaVersion: next.schemaVersion,
          preferences: preferences ?? null,
        };
      }

      for (const groupId of changedGroupIds) {
        writes[groupSettingsStorageKey(groupId)] = next.groups[groupId] ?? null;
      }
      for (const profileId of changedProfileIds) {
        writes[profileSettingsStorageKey(profileId)] = next.profiles[profileId] ?? null;
      }
      if (mergeEnabledChanged) {
        writes[globalSettingsStorageKey] = {
          schemaVersion: next.schemaVersion,
          mergeEnabled: next.mergeEnabled,
        };
      }

      await this.storage.set(writes);

      const updated = migrateSettings(this.settings);
      for (const calendarKey of changedCalendarKeys) {
        const preferences = next.calendars[calendarKey];
        if (preferences) updated.calendars[calendarKey] = preferences;
        else delete updated.calendars[calendarKey];
      }
      if (mergeEnabledChanged) updated.mergeEnabled = next.mergeEnabled;
      for (const groupId of changedGroupIds) {
        const group = next.groups[groupId];
        if (group) updated.groups[groupId] = group;
        else delete updated.groups[groupId];
      }
      for (const profileId of changedProfileIds) {
        const profile = next.profiles[profileId];
        if (profile) updated.profiles[profileId] = profile;
        else delete updated.profiles[profileId];
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

function decodeStorageKey(storageKey: string, prefix: string): string | null {
  if (!storageKey.startsWith(prefix)) return null;
  try {
    const id = decodeURIComponent(storageKey.slice(prefix.length));
    return id.length > 0 && isSafeKey(id) ? id : null;
  } catch {
    return null;
  }
}

function settingsFromStorage(
  stored: Record<string, unknown>,
  calendarKeys?: ReadonlySet<string>,
): Settings {
  const settings = migrateSettings(stored[settingsStorageKey]);
  const global = record(stored[globalSettingsStorageKey]);
  if (global && global.schemaVersion === settings.schemaVersion) {
    if (typeof global.mergeEnabled === "boolean") settings.mergeEnabled = global.mergeEnabled;
  }

  for (const [storageKey, rawGroup] of Object.entries(stored)) {
    const groupId = groupIdFromSettingsStorageKey(storageKey);
    if (!groupId) continue;
    if (rawGroup === null) {
      delete settings.groups[groupId];
      continue;
    }
    const normalized = migrateSettings({
      schemaVersion: settings.schemaVersion,
      mergeEnabled: settings.mergeEnabled,
      groups: { [groupId]: rawGroup },
    }).groups[groupId];
    if (normalized) settings.groups[groupId] = normalized;
    else delete settings.groups[groupId];
  }

  for (const [storageKey, rawProfile] of Object.entries(stored)) {
    const profileId = profileIdFromSettingsStorageKey(storageKey);
    if (!profileId) continue;
    if (rawProfile === null) {
      delete settings.profiles[profileId];
      continue;
    }
    const normalized = migrateSettings({
      schemaVersion: settings.schemaVersion,
      mergeEnabled: settings.mergeEnabled,
      profiles: { [profileId]: rawProfile },
    }).profiles[profileId];
    if (normalized) settings.profiles[profileId] = normalized;
    else delete settings.profiles[profileId];
  }

  for (const [storageKey, rawPreference] of Object.entries(stored)) {
    const calendarKey = calendarKeyFromSettingsStorageKey(storageKey);
    if (calendarKey && (!calendarKeys || calendarKeys.has(calendarKey)))
      applyCalendarPreference(settings, calendarKey, rawPreference);
  }
  return migrateSettings(settings);
}

function changedRecordIds<T>(current: Record<string, T>, next: Record<string, T>): Set<string> {
  const changed = new Set([...Object.keys(current), ...Object.keys(next)]);
  for (const id of changed) if (sameValue(current[id], next[id])) changed.delete(id);
  return changed;
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
