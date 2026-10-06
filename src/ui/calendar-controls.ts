import type { CalendarPreferences, CalendarSnapshot } from "../domain/model";
import type { PanelActions } from "./panel";

export interface CalendarRowControls {
  update(preferences: CalendarPreferences | undefined): void;
  dispose(): void;
}

interface OpenControlPanel {
  hosts: readonly HTMLElement[];
  close(): void;
}

interface ControlPanelRegistry {
  controller: AbortController;
  mountedControls: number;
  open: Set<OpenControlPanel>;
}

interface ControlPanelRegistration {
  setOpen(open: boolean): void;
  dispose(): void;
}

const controlPanelRegistries = new WeakMap<Document, ControlPanelRegistry>();

const triggerStyles = `
:host { all: initial; --gce-text: #202124; --gce-surface: #fff; --gce-input: #fff; --gce-border: #dadce0; --gce-focus: #1a73e8; --gce-ring: #fff; display: inline-flex; flex: none; vertical-align: middle; color-scheme: light; color: var(--gce-text); font: 12px/1.4 Arial, sans-serif; }
:host-context(html[data-theme="dark"]) { --gce-text: #e8eaed; --gce-surface: #292a2d; --gce-input: #202124; --gce-border: #5f6368; --gce-focus: #8ab4f8; --gce-ring: #202124; color-scheme: dark; }
button { cursor: pointer; font: inherit; }
.trigger { width: 18px; height: 18px; margin-inline-start: 2px; padding: 0; border: 1px solid var(--gce-border); border-radius: 50%; background: var(--gce-color); box-shadow: inset 0 0 0 2px var(--gce-ring); }
button:focus-visible { outline: 2px solid var(--gce-focus); outline-offset: 2px; }
`;

const panelStyles = `
:host { all: initial; --gce-text: #202124; --gce-muted: #5f6368; --gce-surface: #fff; --gce-input: #fff; --gce-border: #dadce0; --gce-focus: #1a73e8; display: block; width: calc(100% - 8px); margin: 0 0 6px 8px; box-sizing: border-box; color-scheme: light; color: var(--gce-text); font: 12px/1.4 Arial, sans-serif; }
:host-context(html[data-theme="dark"]) { --gce-text: #e8eaed; --gce-muted: #bdc1c6; --gce-surface: #292a2d; --gce-input: #202124; --gce-border: #5f6368; --gce-focus: #8ab4f8; color-scheme: dark; }
:host([hidden]) { display: none !important; }
button, input { font: inherit; }
button { cursor: pointer; }
.controls-panel { width: 100%; box-sizing: border-box; padding: 10px; border: 1px solid var(--gce-border); border-radius: 8px; background: var(--gce-surface); color: var(--gce-text); box-shadow: 0 2px 8px #0002; }
label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 9px; }
input[type=color] { width: 38px; height: 28px; padding: 1px; }
input[type=range] { width: 125px; }
.reset, .solo { min-height: 28px; padding: 4px 8px; border: 1px solid var(--gce-border); border-radius: 5px; background: var(--gce-input); color: inherit; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--gce-focus); outline-offset: 2px; }
`;

export function mountCalendarRowControls(
  row: HTMLElement,
  controlContainer: HTMLElement,
  panelContainer: HTMLElement,
  calendar: CalendarSnapshot,
  preferences: CalendarPreferences | undefined,
  actions: Pick<
    PanelActions,
    "appearance" | "resetAppearance" | "soloCalendar" | "spotlightCalendar"
  >,
): CalendarRowControls {
  const document = row.ownerDocument;
  const host = document.createElement("span");
  host.setAttribute("data-gce-ui", "");
  host.setAttribute("data-gce-calendar-controls", "");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = triggerStyles;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "trigger";
  trigger.setAttribute("aria-label", `${calendar.label}の色と透明度を設定`);
  trigger.setAttribute("aria-expanded", "false");
  shadow.append(style, trigger);

  const panelHost = document.createElement("div");
  panelHost.setAttribute("data-gce-ui", "");
  panelHost.setAttribute("data-gce-calendar-controls-panel", "");
  panelHost.hidden = true;
  const panelShadow = panelHost.attachShadow({ mode: "open" });
  const panelStyle = document.createElement("style");
  panelStyle.textContent = panelStyles;
  const controlsPanel = document.createElement("div");
  controlsPanel.className = "controls-panel";
  controlsPanel.setAttribute("role", "group");
  controlsPanel.setAttribute("aria-label", `${calendar.label}の表示設定`);
  const colorLabel = document.createElement("label");
  colorLabel.append(document.createTextNode("Color"));
  const color = document.createElement("input");
  color.type = "color";
  color.setAttribute("aria-label", `${calendar.label}の色`);
  colorLabel.append(color);
  const opacityLabel = document.createElement("label");
  const opacityText = document.createElement("span");
  const opacity = document.createElement("input");
  opacity.type = "range";
  opacity.min = "0";
  opacity.max = "1";
  opacity.step = "0.05";
  opacity.setAttribute("aria-label", `${calendar.label}の透明度`);
  opacityLabel.append(opacityText, opacity);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "reset";
  reset.textContent = "Reset";
  reset.setAttribute("aria-label", `${calendar.label}の色と透明度をリセット`);
  const solo = document.createElement("button");
  solo.type = "button";
  solo.className = "solo";
  solo.textContent = "Solo";
  solo.setAttribute("aria-label", `${calendar.label}だけを表示`);
  controlsPanel.append(colorLabel, opacityLabel, reset, solo);
  panelShadow.append(panelStyle, controlsPanel);

  const placeHosts = () => {
    if (host.parentElement !== controlContainer) controlContainer.append(host);
    if (panelContainer === row) {
      if (panelHost.parentElement !== row) row.append(panelHost);
    } else if (panelHost.parentElement !== panelContainer || panelHost.previousSibling !== row) {
      panelContainer.insertBefore(panelHost, row.nextSibling);
    }
  };
  placeHosts();

  const controller = new AbortController();
  const { signal } = controller;
  let configuredColor = preferences?.color;
  let registration: ControlPanelRegistration | undefined;
  const closeControlsPanel = () => {
    panelHost.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    registration?.setOpen(false);
  };
  registration = registerControlPanel(document, [host, panelHost], closeControlsPanel);
  const stopPropagation = (event: Event) => event.stopPropagation();
  trigger.addEventListener(
    "click",
    (event) => {
      event.stopPropagation();
      panelHost.hidden = !panelHost.hidden;
      trigger.setAttribute("aria-expanded", String(!panelHost.hidden));
      registration?.setOpen(!panelHost.hidden);
    },
    { signal },
  );
  for (const element of [color, opacity, reset, solo, controlsPanel, panelHost])
    element.addEventListener("click", stopPropagation, { signal });
  color.addEventListener(
    "input",
    () => {
      configuredColor = color.value;
      actions.appearance(calendar.key, configuredColor, Number(opacity.value), false);
    },
    { signal },
  );
  color.addEventListener(
    "change",
    () => actions.appearance(calendar.key, configuredColor, Number(opacity.value), true),
    { signal },
  );
  opacity.addEventListener(
    "input",
    () => {
      opacityText.textContent = `Opacity ${Math.round(Number(opacity.value) * 100)}%`;
      actions.appearance(calendar.key, configuredColor, Number(opacity.value), false);
    },
    { signal },
  );
  opacity.addEventListener(
    "change",
    () => actions.appearance(calendar.key, configuredColor, Number(opacity.value), true),
    { signal },
  );
  reset.addEventListener("click", () => actions.resetAppearance(calendar.key), { signal });
  solo.addEventListener(
    "click",
    () => {
      closeControlsPanel();
      actions.soloCalendar(calendar.key);
    },
    { signal },
  );
  controlsPanel.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      closeControlsPanel();
      trigger.focus();
    },
    { signal },
  );
  row.addEventListener("pointerenter", () => actions.spotlightCalendar(calendar.key), { signal });
  row.addEventListener("pointerleave", () => actions.spotlightCalendar(null), { signal });
  row.addEventListener("focusin", () => actions.spotlightCalendar(calendar.key), { signal });
  row.addEventListener(
    "focusout",
    (event) => {
      if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
      if (
        event.relatedTarget === panelHost ||
        (event.relatedTarget instanceof Node && panelHost.contains(event.relatedTarget))
      )
        return;
      actions.spotlightCalendar(null);
    },
    { signal },
  );

  const update = (next: CalendarPreferences | undefined) => {
    placeHosts();
    configuredColor = next?.color;
    const nextColor = next?.color ?? calendar.nativeColor ?? "#4285f4";
    color.value = /^#[\da-f]{6}$/iu.test(nextColor) ? nextColor : "#4285f4";
    opacity.value = String(next?.opacity ?? 1);
    opacityText.textContent = `Opacity ${Math.round(Number(opacity.value) * 100)}%`;
    trigger.style.setProperty("--gce-color", nextColor);
  };
  update(preferences);

  return {
    update,
    dispose() {
      controller.abort();
      registration?.dispose();
      host.remove();
      panelHost.remove();
    },
  };
}

function registerControlPanel(
  document: Document,
  hosts: readonly HTMLElement[],
  close: () => void,
): ControlPanelRegistration {
  let registry = controlPanelRegistries.get(document);
  if (!registry) {
    const controller = new AbortController();
    registry = { controller, mountedControls: 0, open: new Set() };
    const activeRegistry = registry;
    document.addEventListener(
      "pointerdown",
      (event) => {
        for (const popover of activeRegistry.open) {
          if (!popover.hosts.some((host) => event.composedPath().includes(host))) popover.close();
        }
      },
      { capture: true, signal: controller.signal },
    );
    controlPanelRegistries.set(document, registry);
  }

  const activeRegistry = registry;
  const controlPanel = { hosts, close };
  activeRegistry.mountedControls += 1;
  return {
    setOpen(open) {
      if (open) activeRegistry.open.add(controlPanel);
      else activeRegistry.open.delete(controlPanel);
    },
    dispose() {
      activeRegistry.open.delete(controlPanel);
      activeRegistry.mountedControls -= 1;
      if (activeRegistry.mountedControls === 0) {
        activeRegistry.controller.abort();
        controlPanelRegistries.delete(document);
      }
    },
  };
}
