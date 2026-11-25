/**
 * A system notification for a new question or an escalation (spec §5.4): through Tauri's plugin
 * in the desktop window, through the Web Notifications API in a browser; silently nothing where
 * neither exists or permission was refused.
 */
export interface Notifier {
  notify(title: string, body: string): Promise<void>;
}

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function systemNotifier(): Notifier {
  return {
    async notify(title, body) {
      if (inTauri()) {
        const plugin = await import("@tauri-apps/plugin-notification");
        let granted = await plugin.isPermissionGranted();
        if (!granted) granted = (await plugin.requestPermission()) === "granted";
        if (granted) plugin.sendNotification({ title, body });
        return;
      }
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default")
        await Notification.requestPermission().catch(() => undefined);
      if (Notification.permission === "granted") new Notification(title, { body });
    },
  };
}
