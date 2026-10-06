import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "Calendar Merger",
    description: "Google Calendarの表示とカレンダー設定を拡張します。",
    permissions: ["storage"],
    host_permissions: [],
  },
});
