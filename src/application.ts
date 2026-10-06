import type { CalendarEvent } from "./domain/model";
import type { LocalStorageArea, StorageChangeEvent } from "./storage/settings";
import type { PanelActions } from "./ui/panel";

import { normalizeOpacity } from "./domain/appearance";
import {
  SoloVisibilityTransaction,
  groupVisibilityTarget,
  profileVisibilityChanges,
  visibilityChanges,
} from "./domain/visibility";
import { GoogleCalendarDomAdapter } from "./gcal/adapter";
import { MutationPipeline } from "./gcal/mutation-pipeline";
import { NativeCalendarVisibilityController } from "./gcal/native-visibility";
import { createCalendarViewAdapters } from "./gcal/view-adapter";
import { EventRenderer } from "./presentation/renderer";
import {
  calendarKeyFromSettingsStorageKey,
  calendarSettingsStorageKey,
  createDefaultSettings,
  isSettingsStorageKey,
  migrateSettings,
  SettingsRepository,
  settingsStorageKey,
} from "./storage/settings";
import { mountCalendarRowControls } from "./ui/calendar-controls";
import { mountPanel } from "./ui/panel";

export interface ApplicationHandle {
  readonly lastMutationFrameDurationMs: number;
  dispose(): void;
}

export async function mountCalendarMergerApplication(
  document: Document,
  uiContainer: HTMLElement,
  storage: LocalStorageArea,
): Promise<ApplicationHandle> {
  const window = document.defaultView;
  if (!window) return { lastMutationFrameDurationMs: 0, dispose() {} };

  const repository = new SettingsRepository(storage);
  const viewAdapters = createCalendarViewAdapters();
  const adapter = new GoogleCalendarDomAdapter(document, viewAdapters);
  let calendars = adapter.listCalendars();
  let settings = await repository
    .load(calendars.filter(({ confidence }) => confidence !== "weak").map(({ key }) => key))
    .catch(() => createDefaultSettings());
  const renderer = new EventRenderer(viewAdapters);
  const visibility = new NativeCalendarVisibilityController(adapter);
  const solo = new SoloVisibilityTransaction();
  const events = new Map<HTMLElement, CalendarEvent>();
  const calendarRowControls = new Map<
    string,
    {
      row: HTMLElement;
      controlContainer: HTMLElement;
      panelContainer: HTMLElement;
      label: string;
      nativeColor?: string;
      dispose(): void;
      update(): void;
    }
  >();
  let currentView = adapter.getCurrentView();
  let panelOpen = false;
  let spotlightKeys = new Set<string>();
  let panelController: AbortController | undefined;
  let panelActions: PanelActions | undefined;
  let panelSignature = "";
  let pendingRender = false;
  let writeQueue = Promise.resolve();
  const lifecycle = new AbortController();
  const safeCalendars = () => calendars.filter((calendar) => calendar.confidence !== "weak");
  const calendarKeysForGroup = (groupId: string) =>
    Object.entries(settings.calendars)
      .filter(([, preferences]) => preferences.groupId === groupId)
      .map(([calendarKey]) => calendarKey);
  const visibilitySnapshot = () =>
    new Map(safeCalendars().map(({ key, visible }) => [key, visible]));
  const identitySignature = () =>
    calendars.map(({ key, confidence }) => `${key}:${confidence}`).join("\u0000");
  const getPanelSignature = () =>
    JSON.stringify([
      calendars.map(({ key, label, confidence, visible, nativeColor }) => [
        key,
        label,
        confidence,
        visible,
        nativeColor,
      ]),
      adapter.getCapabilities([...events.values()]).merge,
    ]);

  const syncCalendarRowControls = (actions: PanelActions) => {
    const activeKeys = new Set<string>();
    for (const calendar of calendars) {
      if (calendar.confidence === "weak") continue;
      const row = adapter.getCalendarRowElement(calendar.key);
      const controlContainer = adapter.getCalendarControlContainer(calendar.key);
      const panelContainer = adapter.getCalendarPanelContainer(calendar.key);
      if (!row || !controlContainer || !panelContainer) continue;
      activeKeys.add(calendar.key);
      const existing = calendarRowControls.get(calendar.key);
      if (
        existing?.row === row &&
        existing.controlContainer === controlContainer &&
        existing.panelContainer === panelContainer &&
        existing.label === calendar.label &&
        existing.nativeColor === calendar.nativeColor
      ) {
        existing.update();
        continue;
      }
      existing?.dispose();
      const controls = mountCalendarRowControls(
        row,
        controlContainer,
        panelContainer,
        calendar,
        settings.calendars[calendar.key],
        actions,
      );
      calendarRowControls.set(calendar.key, {
        row,
        controlContainer,
        panelContainer,
        label: calendar.label,
        ...(calendar.nativeColor ? { nativeColor: calendar.nativeColor } : {}),
        dispose: () => controls.dispose(),
        update: () => controls.update(settings.calendars[calendar.key]),
      });
    }
    for (const [key, controls] of calendarRowControls) {
      if (activeKeys.has(key)) continue;
      controls.dispose();
      calendarRowControls.delete(key);
    }
  };

  const persistSettings = () => {
    settings = migrateSettings(settings);
    const snapshot = migrateSettings(settings);
    writeQueue = writeQueue.then(() => repository.save(snapshot)).catch(() => undefined);
  };

  const renderPanel = () => {
    const inputDrafts = new Map<string, string>();
    for (const input of uiContainer.querySelectorAll<HTMLInputElement>(
      "input[data-gce-draft-key]",
    )) {
      const key = input.dataset.gceDraftKey;
      if (key) inputDrafts.set(key, input.value);
    }
    panelController?.abort();
    const actions: PanelActions = {
      panelVisibilityChanged(open) {
        panelOpen = open;
      },
      toggleMerge() {
        if (!adapter.getCapabilities([...events.values()]).merge) return;
        settings.mergeEnabled = !settings.mergeEnabled;
        persistSettings();
        scheduleRender(true);
      },
      appearance(calendarKey, color, opacity, persist) {
        const calendar = calendars.find((entry) => entry.key === calendarKey);
        if (!calendar || calendar.confidence === "weak") return;
        const previous = settings.calendars[calendarKey];
        const next = {
          opacity: normalizeOpacity(opacity),
          ...(color !== undefined
            ? { color: color.toLowerCase() }
            : previous?.color
              ? { color: previous.color }
              : {}),
          ...(previous?.groupId ? { groupId: previous.groupId } : {}),
        };
        settings.calendars[calendarKey] = next;
        if (persist) persistSettings();
        scheduleRender(false);
      },
      resetAppearance(calendarKey) {
        const calendar = calendars.find((entry) => entry.key === calendarKey);
        if (!calendar || calendar.confidence === "weak") return;
        const groupId = settings.calendars[calendarKey]?.groupId;
        if (groupId) settings.calendars[calendarKey] = { groupId, opacity: 1 };
        else delete settings.calendars[calendarKey];
        persistSettings();
        scheduleRender(true);
      },
      assignGroup(calendarKey, groupId) {
        const calendar = calendars.find((entry) => entry.key === calendarKey);
        if (
          !calendar ||
          calendar.confidence === "weak" ||
          (groupId && !Object.hasOwn(settings.groups, groupId))
        )
          return;
        const previous = settings.calendars[calendarKey];
        if (groupId) {
          settings.calendars[calendarKey] = {
            opacity: previous?.opacity ?? 1,
            ...(previous?.color ? { color: previous.color } : {}),
            groupId,
          };
        } else if (previous?.color || (previous?.opacity !== undefined && previous.opacity !== 1)) {
          settings.calendars[calendarKey] = {
            opacity: previous.opacity,
            ...(previous.color ? { color: previous.color } : {}),
          };
        } else {
          delete settings.calendars[calendarKey];
        }
        persistSettings();
        scheduleRender(true);
      },
      toggleCalendar(calendarKey) {
        if (!safeCalendars().some(({ key }) => key === calendarKey)) return;
        visibility.toggle(calendarKey);
      },
      soloCalendar(calendarKey) {
        const calendar = safeCalendars().find((entry) => entry.key === calendarKey);
        if (!calendar) return;
        visibility.apply(solo.enter(new Set([calendarKey]), visibilitySnapshot()));
        scheduleRender(true);
      },
      soloGroup(groupId) {
        const group = settings.groups[groupId];
        if (!Object.hasOwn(settings.groups, groupId) || !group) return;
        const available = new Set(safeCalendars().map(({ key }) => key));
        visibility.apply(
          solo.enter(
            new Set(calendarKeysForGroup(groupId).filter((key) => available.has(key))),
            visibilitySnapshot(),
          ),
        );
        scheduleRender(true);
      },
      exitSolo() {
        visibility.apply(solo.restore(visibilitySnapshot()));
        scheduleRender(true);
      },
      toggleGroup(groupId) {
        const group = settings.groups[groupId];
        if (!Object.hasOwn(settings.groups, groupId) || !group) return;
        const current = visibilitySnapshot();
        const groupCalendarKeys = calendarKeysForGroup(groupId);
        const target = groupVisibilityTarget(groupCalendarKeys, current);
        const desired = new Set([...current].filter(([, visible]) => visible).map(([key]) => key));
        for (const key of groupCalendarKeys) {
          if (!current.has(key)) continue;
          if (target) desired.add(key);
          else desired.delete(key);
        }
        visibility.apply(visibilityChanges(current, desired));
      },
      createGroup(name) {
        const id = window.crypto.randomUUID();
        settings.groups[id] = { id, name };
        persistSettings();
        scheduleRender(true);
      },
      renameGroup(groupId, name) {
        const group = settings.groups[groupId];
        if (!group) return;
        group.name = name;
        persistSettings();
        scheduleRender(true);
      },
      deleteGroup(groupId) {
        if (!Object.hasOwn(settings.groups, groupId)) return;
        for (const [key, preferences] of Object.entries(settings.calendars)) {
          if (preferences.groupId !== groupId) continue;
          if (preferences.color || preferences.opacity !== 1) {
            settings.calendars[key] = {
              opacity: preferences.opacity,
              ...(preferences.color ? { color: preferences.color } : {}),
            };
          } else delete settings.calendars[key];
        }
        delete settings.groups[groupId];
        persistSettings();
        scheduleRender(true);
      },
      createProfile(name) {
        const id = window.crypto.randomUUID();
        const visibleCalendarKeys = safeCalendars()
          .filter(({ visible }) => visible)
          .map(({ key }) => key);
        settings.profiles[id] = { id, name, visibleCalendarKeys };
        persistSettings();
        scheduleRender(true);
      },
      applyProfile(profileId) {
        const profile = settings.profiles[profileId];
        if (!profile) return;
        visibility.apply(profileVisibilityChanges(profile, visibilitySnapshot()));
      },
      updateProfile(profileId) {
        const profile = settings.profiles[profileId];
        if (!profile) return;
        profile.visibleCalendarKeys = safeCalendars()
          .filter(({ visible }) => visible)
          .map(({ key }) => key);
        persistSettings();
        scheduleRender(true);
      },
      renameProfile(profileId, name) {
        const profile = settings.profiles[profileId];
        if (!profile) return;
        profile.name = name;
        persistSettings();
        scheduleRender(true);
      },
      deleteProfile(profileId) {
        delete settings.profiles[profileId];
        persistSettings();
        scheduleRender(true);
      },
      spotlightCalendar(calendarKey) {
        spotlightKeys = calendarKey ? new Set([calendarKey]) : new Set();
        scheduleRender(false);
      },
      spotlightGroup(groupId) {
        const keys =
          groupId && Object.hasOwn(settings.groups, groupId) ? calendarKeysForGroup(groupId) : [];
        spotlightKeys = new Set(keys);
        scheduleRender(false);
      },
    };

    panelController = mountPanel(
      uiContainer,
      {
        calendars,
        settings,
        soloActive: solo.active,
        open: panelOpen,
        mergeAvailable: adapter.getCapabilities([...events.values()]).merge,
      },
      actions,
    );
    for (const input of uiContainer.querySelectorAll<HTMLInputElement>(
      "input[data-gce-draft-key]",
    )) {
      const key = input.dataset.gceDraftKey;
      const draft = key ? inputDrafts.get(key) : undefined;
      if (draft !== undefined) input.value = draft;
    }
    panelActions = actions;
    syncCalendarRowControls(actions);
  };

  const renderEvents = () => renderer.render(events, calendars, settings, spotlightKeys);

  const scheduleRender = (refreshPanel: boolean) => {
    if (refreshPanel) renderPanel();
    if (pendingRender) return;
    pendingRender = true;
    window.requestAnimationFrame(() => {
      pendingRender = false;
      renderEvents();
    });
  };

  const observedGeometryContainers = new Set<Element>();
  const geometryResizeObserver = window.ResizeObserver
    ? new window.ResizeObserver(() => {
        if (lifecycle.signal.aborted) return;
        renderer.invalidateGeometry();
        scheduleRender(false);
      })
    : undefined;
  const syncGeometryObservers = () => {
    if (!geometryResizeObserver) return;
    const nextContainers = new Set<Element>();
    for (const element of events.keys()) {
      if (element.offsetParent) nextContainers.add(element.offsetParent);
    }
    for (const container of observedGeometryContainers)
      if (!nextContainers.has(container)) geometryResizeObserver.unobserve(container);
    for (const container of nextContainers)
      if (!observedGeometryContainers.has(container)) geometryResizeObserver.observe(container);
    observedGeometryContainers.clear();
    for (const container of nextContainers) observedGeometryContainers.add(container);
  };

  window.addEventListener(
    "resize",
    () => {
      renderer.invalidateGeometry();
      scheduleRender(false);
    },
    { signal: lifecycle.signal },
  );

  const initializeEvents = () => {
    events.clear();
    for (const entry of adapter.listVisibleEventEntries()) events.set(entry.element, entry.event);
  };

  const refreshPanelIfChanged = () => {
    const signature = getPanelSignature();
    if (signature === panelSignature) {
      if (panelActions) syncCalendarRowControls(panelActions);
      return;
    }
    panelSignature = signature;
    renderPanel();
  };

  const pipeline = new MutationPipeline(
    document,
    (dirty, positionedEvents) => {
      const fullScan = dirty.has(document.documentElement);
      const previousIdentity = identitySignature();
      const view = adapter.getCurrentView();
      const viewChanged = view !== currentView;
      currentView = view;
      const calendarChanged = fullScan || adapter.hasCalendarChanges(dirty);
      const dirtyEvents = new Set(adapter.resolveDirtyEventElements(dirty));
      const renderAll = fullScan || viewChanged || calendarChanged;
      const eventStructureChanged = [...dirtyEvents].some(
        (element) => !events.has(element) || !element.isConnected,
      );
      const eventPositionChanged = [...dirtyEvents].some((element) =>
        positionedEvents.has(element),
      );

      if (calendarChanged) {
        const previousKeys = new Set(safeCalendars().map(({ key }) => key));
        calendars = adapter.listCalendars();
        const newlyDiscoveredKeys = calendars
          .filter(({ confidence, key }) => confidence !== "weak" && !previousKeys.has(key))
          .map(({ key }) => key);
        if (newlyDiscoveredKeys.length > 0) {
          void repository
            .loadCalendarSettings(newlyDiscoveredKeys)
            .then((latestSettings) => {
              if (lifecycle.signal.aborted) return;
              for (const key of newlyDiscoveredKeys) {
                const preferences = latestSettings.calendars[key];
                if (preferences) settings.calendars[key] = preferences;
                else delete settings.calendars[key];
              }
              renderPanel();
              scheduleRender(false);
            })
            .catch(() => undefined);
        }
      }
      const calendarIdentityChanged = previousIdentity !== identitySignature();
      if (renderAll || calendarIdentityChanged || eventStructureChanged || eventPositionChanged)
        renderer.invalidateGeometry();
      if (renderAll || calendarIdentityChanged) {
        initializeEvents();
      } else {
        for (const element of dirtyEvents) {
          if (!element.isConnected) {
            events.delete(element);
            continue;
          }
          const event = adapter.resolveEvent(element);
          if (event) events.set(element, event);
          else events.delete(element);
        }
      }
      syncGeometryObservers();

      if (calendarChanged) refreshPanelIfChanged();
      if (!renderAll && !calendarIdentityChanged && dirtyEvents.size === 0) return;
      const renderedEvents = new Map(events);
      const renderedCalendars = [...calendars];
      const renderedSettings = migrateSettings(settings);
      const renderedSpotlight = new Set(spotlightKeys);
      return () =>
        renderer.render(
          renderedEvents,
          renderedCalendars,
          renderedSettings,
          renderedSpotlight,
          renderAll || calendarIdentityChanged ? undefined : dirtyEvents,
        );
    },
    (element) => renderer.isOwnStyleMutation(element),
    (element) => {
      const dirty = new Set<Node>([element]);
      return (
        adapter.resolveDirtyEventElements(dirty).length > 0 || adapter.hasCalendarChanges(dirty)
      );
    },
  );

  renderPanel();
  pipeline.start();

  const chromeWindow = window as Window & {
    chrome?: { storage?: { onChanged?: StorageChangeEvent } };
  };
  const storageChanged = chromeWindow.chrome?.storage?.onChanged;
  const pendingStorageKeys = new Set<string>();
  let storageRefreshScheduled = false;
  const refreshSettingsFromStorage = () => {
    if (storageRefreshScheduled) return;
    storageRefreshScheduled = true;
    queueMicrotask(() => {
      storageRefreshScheduled = false;
      const changedKeys = [...pendingStorageKeys];
      pendingStorageKeys.clear();
      if (changedKeys.length === 0 || lifecycle.signal.aborted) return;

      void repository
        .refreshChangedKeys(changedKeys)
        .then((latestSettings) => {
          if (lifecycle.signal.aborted) return;
          const updated = migrateSettings(settings);
          for (const key of changedKeys) {
            if (key === settingsStorageKey) {
              updated.mergeEnabled = latestSettings.mergeEnabled;
              updated.groups = latestSettings.groups;
              updated.profiles = latestSettings.profiles;
              continue;
            }
            const calendarKey = calendarKeyFromSettingsStorageKey(key);
            if (!calendarKey) continue;
            const preferences = latestSettings.calendars[calendarKey];
            if (preferences) updated.calendars[calendarKey] = preferences;
            else delete updated.calendars[calendarKey];
          }
          settings = migrateSettings(updated);
          panelSignature = "";
          renderPanel();
          scheduleRender(false);
          if (pendingStorageKeys.size > 0) refreshSettingsFromStorage();
        })
        .catch(() => {
          if (pendingStorageKeys.size > 0) refreshSettingsFromStorage();
        });
    });
  };
  const onStorageChanged = (changes: Record<string, unknown>, areaName: string) => {
    if (areaName !== "local") return;
    for (const key of Object.keys(changes))
      if (isSettingsStorageKey(key)) pendingStorageKeys.add(key);
    if (pendingStorageKeys.size > 0) refreshSettingsFromStorage();
  };
  storageChanged?.addListener(onStorageChanged);
  lifecycle.signal.addEventListener(
    "abort",
    () => storageChanged?.removeListener(onStorageChanged),
    { once: true },
  );
  pendingStorageKeys.add(settingsStorageKey);
  for (const { key } of safeCalendars()) pendingStorageKeys.add(calendarSettingsStorageKey(key));
  refreshSettingsFromStorage();

  return {
    get lastMutationFrameDurationMs() {
      return pipeline.lastFrameDurationMs;
    },
    dispose() {
      lifecycle.abort();
      geometryResizeObserver?.disconnect();
      observedGeometryContainers.clear();
      pipeline.dispose();
      visibility.apply(solo.restore(visibilitySnapshot()));
      renderer.restoreAll();
      panelController?.abort();
      for (const controls of calendarRowControls.values()) controls.dispose();
      calendarRowControls.clear();
      events.clear();
    },
  };
}
