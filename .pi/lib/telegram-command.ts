import {
  registerTelegramCommand,
  type TelegramExtensionCommandRegistration,
} from "@llblab/pi-telegram/commands";

/**
 * Register a Telegram-visible slash command that survives Pi's /reload.
 *
 * Prefer this over `pi.registerCommand`: only the fork's Telegram registry is
 * dispatched at the Telegram routing layer AND listed in the `/` autocomplete
 * menu (when `showInMenu` is set). `pi.registerCommand` commands still run when
 * typed but only reach Pi as a forwarded turn, so they never show in autocomplete.
 *
 * That registry is process-global and outlives the extension factory, which Pi
 * re-runs on /reload. We stash the unbind on a global symbol keyed by command
 * name and clear the prior registration before re-registering, so a reload never
 * throws "already registered".
 *
 * Lives in `.pi/lib/` (not `.pi/extensions/`) so it is never auto-loaded as an
 * extension; extension files import it with `../lib/telegram-command.ts`.
 */
export function registerReloadSafeTelegramCommand(
  registration: TelegramExtensionCommandRegistration,
): void {
  const key = Symbol.for(
    `pi-telegram-bridge.command-unbind.${registration.name}`,
  );
  const store = globalThis as Record<PropertyKey, unknown>;
  (store[key] as (() => void) | undefined)?.();
  store[key] = registerTelegramCommand(registration);
}
