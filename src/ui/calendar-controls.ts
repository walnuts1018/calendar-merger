import type { CalendarPreferences, CalendarSnapshot } from "../domain/model";
import type { PanelActions } from "./panel";

export interface CalendarRowControls {
  update(preferences: CalendarPreferences | undefined): void;
  dispose(): void;
}

interface OpenPopover {
  host: HTMLElement;
  close(): void;
}

interface PopoverRegistry {
  controller: AbortController;
  mountedControls: number;
  open: Set<OpenPopover>;
}

interface PopoverRegistration {
  setOpen(open: boolean): void;
  dispose(): void;
}

const popoverRegistries = new WeakMap<Document, PopoverRegistry>();

const styles = `
:host { all: initial; position: relative; display: inline-flex; color: #202124; font: 12px/1.4 Arial, sans-serif; }
button, input { font: inherit; }
button { cursor: pointer; }
.trigger { width: 22px; height: 22px; padding: 0; border: 1px solid #dadce0; border-radius: 50%; background: var(--gce-color); box-shadow: inset 0 0 0 2px #fff; }
.popover { position: absolute; top: 24px; left: 0; z-index: 2147483647; width: 220px; padding: 10px; border: 1px solid #dadce0; border-radius: 8px; background: #fff; box-shadow: 0 4px 16px #0004; }
.popover[hidden] { display: none; }
label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 9px; }
input[type=color] { width: 38px; height: 28px; padding: 1px; }
input[type=range] { width: 125px; }
.reset, .solo { min-height: 28px; padding: 4px 8px; border: 1px solid #dadce0; border-radius: 5px; background: #fff; }
button:focus-visible, input:focus-visible { outline: 2px solid #1a73e8; outline-offset: 2px; }
`;

export function mountCalendarRowControls(
  row: HTMLElement,
  calendar: CalendarSnapshot,
  preferences: CalendarPreferences | undefined,
  actions: Pick<
    PanelActions,
    "appearance" | "resetAppearance" | "soloCalendar" | "spotlightCalendar"
  >,
): CalendarRowControls {
  const document = row.ownerDocument;
  for (const orphan of row.querySelectorAll<HTMLElement>(":scope > [data-gce-calendar-controls]")) {
    if (!orphan.shadowRoot) orphan.remove();
  }
  const host = document.createElement("span");
  host.setAttribute("data-gce-ui", "");
  host.setAttribute("data-gce-calendar-controls", "");
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = styles;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "trigger";
  trigger.setAttribute("aria-label", `${calendar.label}の色と透明度を設定`);
  trigger.setAttribute("aria-expanded", "false");
  const popover = document.createElement("div");
  popover.className = "popover";
  popover.setAttribute("role", "group");
  popover.setAttribute("aria-label", `${calendar.label}の表示設定`);
  popover.hidden = true;
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
  popover.append(colorLabel, opacityLabel, reset, solo);
  shadow.append(style, trigger, popover);
  row.append(host);

  const controller = new AbortController();
  const { signal } = controller;
  let configuredColor = preferences?.color;
  let registration: PopoverRegistration | undefined;
  const closePopover = () => {
    popover.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    registration?.setOpen(false);
  };
  registration = registerPopover(document, host, closePopover);
  const stopPropagation = (event: Event) => event.stopPropagation();
  trigger.addEventListener(
    "click",
    (event) => {
      event.stopPropagation();
      popover.hidden = !popover.hidden;
      trigger.setAttribute("aria-expanded", String(!popover.hidden));
      registration?.setOpen(!popover.hidden);
    },
    { signal },
  );
  for (const element of [color, opacity, reset, solo, popover])
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
      closePopover();
      actions.soloCalendar(calendar.key);
    },
    { signal },
  );
  popover.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      closePopover();
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
      actions.spotlightCalendar(null);
    },
    { signal },
  );

  const update = (next: CalendarPreferences | undefined) => {
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
    },
  };
}

function registerPopover(
  document: Document,
  host: HTMLElement,
  close: () => void,
): PopoverRegistration {
  let registry = popoverRegistries.get(document);
  if (!registry) {
    const controller = new AbortController();
    registry = { controller, mountedControls: 0, open: new Set() };
    const activeRegistry = registry;
    document.addEventListener(
      "pointerdown",
      (event) => {
        for (const popover of activeRegistry.open) {
          if (!event.composedPath().includes(popover.host)) popover.close();
        }
      },
      { capture: true, signal: controller.signal },
    );
    popoverRegistries.set(document, registry);
  }

  const activeRegistry = registry;
  const popover = { host, close };
  activeRegistry.mountedControls += 1;
  return {
    setOpen(open) {
      if (open) activeRegistry.open.add(popover);
      else activeRegistry.open.delete(popover);
    },
    dispose() {
      activeRegistry.open.delete(popover);
      activeRegistry.mountedControls -= 1;
      if (activeRegistry.mountedControls === 0) {
        activeRegistry.controller.abort();
        popoverRegistries.delete(document);
      }
    },
  };
}
