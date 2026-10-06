import type { CalendarGroup, CalendarSnapshot, VisibilityProfile } from "../domain/model";
import type { Settings } from "../storage/settings";

export interface PanelActions {
  panelVisibilityChanged(open: boolean): void;
  toggleMerge(): void;
  appearance(
    calendarKey: string,
    color: string | undefined,
    opacity: number,
    persist: boolean,
  ): void;
  resetAppearance(calendarKey: string): void;
  assignGroup(calendarKey: string, groupId: string | undefined): void;
  toggleCalendar(calendarKey: string): void;
  soloCalendar(calendarKey: string): void;
  soloGroup(groupId: string): void;
  exitSolo(): void;
  toggleGroup(groupId: string): void;
  createGroup(name: string): void;
  renameGroup(groupId: string, name: string): void;
  deleteGroup(groupId: string): void;
  createProfile(name: string): void;
  applyProfile(profileId: string): void;
  updateProfile(profileId: string): void;
  renameProfile(profileId: string, name: string): void;
  deleteProfile(profileId: string): void;
  spotlightCalendar(calendarKey: string | null): void;
  spotlightGroup(groupId: string | null): void;
}

export interface PanelState {
  calendars: readonly CalendarSnapshot[];
  settings: Settings;
  soloActive: boolean;
  open: boolean;
  mergeAvailable: boolean;
}

const styles = `
:host { all: initial; --gce-text: #202124; --gce-muted: #5f6368; --gce-surface: #fff; --gce-input: #fff; --gce-border: #dadce0; --gce-subtle-border: #e8eaed; --gce-hover: #f1f3f4; --gce-selected: #e8f0fe; --gce-focus: #1a73e8; color-scheme: light; color: var(--gce-text); font: 13px/1.45 Arial, sans-serif; }
:host-context(html[data-theme="dark"]) { --gce-text: #e8eaed; --gce-muted: #bdc1c6; --gce-surface: #292a2d; --gce-input: #202124; --gce-border: #5f6368; --gce-subtle-border: #3c4043; --gce-hover: #3c4043; --gce-selected: #394b65; --gce-focus: #8ab4f8; color-scheme: dark; }
.gce-shell { position: static; width: min(310px, 100%); color: var(--gce-text); pointer-events: auto; }
.gce-trigger, .gce-panel button, .gce-panel input, .gce-panel select { font: inherit; }
.gce-trigger { border: 0; border-radius: 20px; background: #1a73e8; color: white; padding: 9px 14px; box-shadow: 0 2px 8px #0003; cursor: pointer; }
.gce-panel { width: 100%; max-height: min(60vh, 560px); overflow: auto; margin-top: 8px; padding: 12px; box-sizing: border-box; border: 1px solid var(--gce-border); border-radius: 12px; background: var(--gce-surface); color: var(--gce-text); box-shadow: 0 6px 24px #0003; }
.gce-panel[hidden] { display: none; }
.gce-heading { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.gce-heading h2 { margin: 0; font-size: 16px; }
.gce-section { border-top: 1px solid var(--gce-border); padding-top: 10px; margin-top: 10px; }
.gce-section h3 { margin: 0 0 7px; font-size: 13px; }
.gce-calendar, .gce-entity { border: 1px solid var(--gce-subtle-border); border-radius: 8px; padding: 8px; margin: 6px 0; }
.gce-calendar-head, .gce-actions { display: flex; align-items: center; gap: 6px; }
.gce-calendar-head { justify-content: space-between; }
.gce-calendar-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.gce-calendar-controls, .gce-entity-fields { display: grid; grid-template-columns: 1fr auto; gap: 6px 8px; align-items: center; margin-top: 7px; }
.gce-calendar-controls label, .gce-entity-fields label { display: contents; }
.gce-calendar-controls input[type=color] { width: 34px; height: 26px; padding: 1px; }
.gce-calendar-controls input[type=range] { width: 132px; }
.gce-panel input[type=text], .gce-panel select { min-width: 0; width: 100%; box-sizing: border-box; padding: 5px; border: 1px solid var(--gce-border); border-radius: 5px; background: var(--gce-input); color: inherit; }
.gce-panel button { min-height: 28px; padding: 4px 8px; border: 1px solid var(--gce-border); border-radius: 5px; background: var(--gce-input); color: inherit; cursor: pointer; }
.gce-panel button:hover { background: var(--gce-hover); }
.gce-panel button[data-primary] { background: #1a73e8; border-color: #1a73e8; color: #fff; }
.gce-panel button:focus-visible, .gce-panel input:focus-visible, .gce-panel select:focus-visible { outline: 2px solid var(--gce-focus); outline-offset: 2px; }
.gce-calendar select { margin-top: 7px; }
.gce-weak { color: var(--gce-muted); font-size: 11px; }
.gce-empty { margin: 4px 0; color: var(--gce-muted); }
.gce-solo { padding: 6px 8px; border-radius: 6px; background: var(--gce-selected); }
`;

export function mountPanel(
  container: HTMLElement,
  state: PanelState,
  actions: PanelActions,
): AbortController {
  const controller = new AbortController();
  const { signal } = controller;
  const document = container.ownerDocument;
  const shell = document.createElement("div");
  shell.className = "gce-shell";
  shell.setAttribute("data-gce-ui", "");
  const style = document.createElement("style");
  style.textContent = styles;
  container.append(style, shell);

  const trigger = button(document, "Calendar Merger", "設定パネルを開く");
  trigger.className = "gce-trigger";
  trigger.setAttribute("aria-expanded", String(state.open));
  trigger.setAttribute("aria-controls", "gce-panel");
  const panel = document.createElement("section");
  panel.id = "gce-panel";
  panel.className = "gce-panel";
  panel.setAttribute("aria-label", "カレンダーの表示設定");
  panel.hidden = !state.open;
  trigger.addEventListener(
    "click",
    () => {
      panel.hidden = !panel.hidden;
      trigger.setAttribute("aria-expanded", String(!panel.hidden));
      actions.panelVisibilityChanged(!panel.hidden);
    },
    { signal },
  );
  shell.append(trigger, panel);

  const heading = document.createElement("div");
  heading.className = "gce-heading";
  const title = document.createElement("h2");
  title.textContent = "Calendar Merger";
  const close = button(document, "閉じる", "設定パネルを閉じる");
  close.addEventListener(
    "click",
    () => {
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      actions.panelVisibilityChanged(false);
      trigger.focus();
    },
    { signal },
  );
  panel.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape") return;
      panel.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      actions.panelVisibilityChanged(false);
      trigger.focus();
    },
    { signal },
  );
  heading.append(title, close);
  panel.append(heading);

  const mergeToggle = button(
    document,
    state.mergeAvailable
      ? state.settings.mergeEnabled
        ? "Merge: On"
        : "Merge: Off"
      : "Merge: unavailable",
    state.mergeAvailable
      ? "Mergeの有効状態を切り替える"
      : "予定情報を安全に識別できないためMergeを無効にしています",
  );
  mergeToggle.disabled = !state.mergeAvailable;
  mergeToggle.setAttribute("aria-pressed", String(state.settings.mergeEnabled));
  mergeToggle.addEventListener("click", () => actions.toggleMerge(), { signal });
  panel.append(mergeToggle);

  if (state.soloActive) {
    const solo = document.createElement("div");
    solo.className = "gce-solo";
    const soloText = document.createElement("span");
    soloText.textContent = "Solo表示中";
    const exit = button(document, "Soloを解除", "Solo表示を解除");
    exit.addEventListener("click", () => actions.exitSolo(), { signal });
    solo.append(soloText, exit);
    panel.append(solo);
  }

  const calendarsSection = section(document, "カレンダー");
  if (state.calendars.length === 0) {
    emptyMessage(
      document,
      calendarsSection,
      "カレンダーを検出できません。Google Calendarのカレンダー一覧が表示されると操作できます。",
    );
  }
  for (const calendar of state.calendars) {
    const preferences = state.settings.calendars[calendar.key];
    calendarsSection.append(
      createCalendarRow(document, calendar, preferences, state.settings.groups, actions, signal),
    );
  }
  panel.append(calendarsSection);

  const groupsSection = section(document, "グループ");
  const createGroupForm = document.createElement("form");
  const groupName = textInput(document, "グループ名", "新しいグループ名", "create-group");
  const createGroup = button(document, "作成", "グループを作成");
  createGroup.type = "submit";
  createGroup.setAttribute("data-primary", "");
  createGroupForm.className = "gce-actions";
  createGroupForm.append(groupName, createGroup);
  createGroupForm.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (groupName.value.trim()) actions.createGroup(groupName.value.trim());
    },
    { signal },
  );
  groupsSection.append(createGroupForm);
  const groups = Object.values(state.settings.groups);
  if (groups.length === 0) emptyMessage(document, groupsSection, "グループはありません。");
  for (const group of groups)
    groupsSection.append(createGroupRow(document, group, actions, signal));
  panel.append(groupsSection);

  const profilesSection = section(document, "プロファイル");
  const createProfileForm = document.createElement("form");
  const profileName = textInput(document, "プロファイル名", "現在の表示を保存", "create-profile");
  const createProfile = button(document, "保存", "現在の表示をプロファイルとして保存");
  createProfile.type = "submit";
  createProfile.setAttribute("data-primary", "");
  createProfileForm.className = "gce-actions";
  createProfileForm.append(profileName, createProfile);
  createProfileForm.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      if (profileName.value.trim()) actions.createProfile(profileName.value.trim());
    },
    { signal },
  );
  profilesSection.append(createProfileForm);
  const profiles = Object.values(state.settings.profiles);
  if (profiles.length === 0) emptyMessage(document, profilesSection, "プロファイルはありません。");
  for (const profile of profiles)
    profilesSection.append(createProfileRow(document, profile, actions, signal));
  panel.append(profilesSection);

  signal.addEventListener(
    "abort",
    () => {
      shell.remove();
      style.remove();
    },
    { once: true },
  );
  return controller;
}

function createCalendarRow(
  document: Document,
  calendar: CalendarSnapshot,
  preferences: Settings["calendars"][string] | undefined,
  groups: Record<string, CalendarGroup>,
  actions: PanelActions,
  signal: AbortSignal,
): HTMLElement {
  const row = document.createElement("article");
  row.className = "gce-calendar";
  const head = document.createElement("div");
  head.className = "gce-calendar-head";
  const name = document.createElement("span");
  name.className = "gce-calendar-name";
  name.textContent = calendar.label;
  const visibility = button(
    document,
    calendar.visible ? "表示中" : "非表示",
    `${calendar.label}の表示を切り替える`,
  );
  visibility.disabled = calendar.confidence === "weak";
  visibility.addEventListener("click", () => actions.toggleCalendar(calendar.key), { signal });
  head.append(name, visibility);
  row.append(head);

  if (calendar.confidence === "weak") {
    const warning = document.createElement("p");
    warning.className = "gce-weak";
    warning.textContent = "識別情報が不足しているため、保存設定とMergeを無効にしています。";
    row.append(warning);
  } else {
    const groupSelect = document.createElement("select");
    groupSelect.setAttribute("aria-label", `${calendar.label}のグループ`);
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "グループなし";
    groupSelect.append(none);
    for (const group of Object.values(groups)) {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = group.name;
      groupSelect.append(option);
    }
    groupSelect.value = preferences?.groupId ?? "";
    groupSelect.addEventListener(
      "change",
      () => actions.assignGroup(calendar.key, groupSelect.value || undefined),
      { signal },
    );
    row.append(groupSelect);
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "gce-actions";
  const solo = button(document, "Solo", `${calendar.label}だけを表示`);
  solo.disabled = calendar.confidence === "weak";
  solo.addEventListener("click", () => actions.soloCalendar(calendar.key), { signal });
  const spotlight = button(document, "Spotlight", `${calendar.label}をSpotlight`);
  spotlight.disabled = calendar.confidence === "weak";
  spotlight.addEventListener("pointerenter", () => actions.spotlightCalendar(calendar.key), {
    signal,
  });
  spotlight.addEventListener("pointerleave", () => actions.spotlightCalendar(null), { signal });
  spotlight.addEventListener("focus", () => actions.spotlightCalendar(calendar.key), { signal });
  spotlight.addEventListener("blur", () => actions.spotlightCalendar(null), { signal });
  actionsRow.append(solo, spotlight);
  row.append(actionsRow);
  return row;
}

function createGroupRow(
  document: Document,
  group: CalendarGroup,
  actions: PanelActions,
  signal: AbortSignal,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "gce-entity";
  const name = textInput(
    document,
    `グループ「${group.name}」の名前`,
    group.name,
    `group:${group.id}:name`,
  );
  name.value = group.name;
  const rename = button(document, "名前を変更", `${group.name}の名前を変更`);
  rename.addEventListener(
    "click",
    () => {
      if (name.value.trim()) actions.renameGroup(group.id, name.value.trim());
    },
    { signal },
  );
  const toggle = button(document, "表示切替", `${group.name}の表示を切り替える`);
  toggle.addEventListener("click", () => actions.toggleGroup(group.id), { signal });
  const solo = button(document, "Solo", `${group.name}だけを表示`);
  solo.addEventListener("click", () => actions.soloGroup(group.id), { signal });
  const spotlight = button(document, "Spotlight", `${group.name}をSpotlight`);
  spotlight.addEventListener("pointerenter", () => actions.spotlightGroup(group.id), { signal });
  spotlight.addEventListener("pointerleave", () => actions.spotlightGroup(null), { signal });
  spotlight.addEventListener("focus", () => actions.spotlightGroup(group.id), { signal });
  spotlight.addEventListener("blur", () => actions.spotlightGroup(null), { signal });
  const remove = button(document, "削除", `${group.name}を削除`);
  remove.addEventListener("click", () => actions.deleteGroup(group.id), { signal });
  row.append(name, rename, toggle, solo, spotlight, remove);
  return row;
}

function createProfileRow(
  document: Document,
  profile: VisibilityProfile,
  actions: PanelActions,
  signal: AbortSignal,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "gce-entity";
  const name = textInput(
    document,
    `プロファイル「${profile.name}」の名前`,
    profile.name,
    `profile:${profile.id}:name`,
  );
  name.value = profile.name;
  const rename = button(document, "名前を変更", `${profile.name}の名前を変更`);
  rename.addEventListener(
    "click",
    () => {
      if (name.value.trim()) actions.renameProfile(profile.id, name.value.trim());
    },
    { signal },
  );
  const apply = button(document, "適用", `${profile.name}を適用`);
  apply.setAttribute("data-primary", "");
  apply.addEventListener("click", () => actions.applyProfile(profile.id), { signal });
  const update = button(document, "現在の表示に更新", `${profile.name}を現在の表示に更新`);
  update.addEventListener("click", () => actions.updateProfile(profile.id), { signal });
  const remove = button(document, "削除", `${profile.name}を削除`);
  remove.addEventListener("click", () => actions.deleteProfile(profile.id), { signal });
  row.append(name, rename, apply, update, remove);
  return row;
}

function section(document: Document, title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "gce-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function emptyMessage(document: Document, parent: HTMLElement, text: string): void {
  const message = document.createElement("p");
  message.className = "gce-empty";
  message.textContent = text;
  parent.append(message);
}

function button(document: Document, text: string, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.setAttribute("aria-label", label);
  return element;
}

function textInput(
  document: Document,
  label: string,
  placeholder: string,
  draftKey: string,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = placeholder;
  input.dataset.gceDraftKey = draftKey;
  input.setAttribute("aria-label", label);
  return input;
}
