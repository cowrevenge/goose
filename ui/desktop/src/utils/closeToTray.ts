/**
 * Whether closing a window should hide it to the tray instead of closing it.
 *
 * Hiding keeps the window's renderer and its backend lease alive, so a run in progress keeps going
 * and the tray brings the window back as it was. Only the last visible window hides; closing an
 * extra window still closes it, so hidden windows (and their backend leases) don't pile up.
 */
export interface CloseToTrayInput {
  /** The closeToTray setting. */
  enabled: boolean;
  /** A real quit is in progress (tray Quit, update install, OS shutdown or logoff). */
  isQuitting: boolean;
  /** The tray icon exists, so there is a way to bring the window back. */
  hasTray: boolean;
  platform: string;
  /** Other windows of this app that are currently visible. */
  otherVisibleWindows: number;
}

export function shouldHideOnClose({
  enabled,
  isQuitting,
  hasTray,
  platform,
  otherVisibleWindows,
}: CloseToTrayInput): boolean {
  // macOS keeps its own convention: the app stays in the dock after the last window closes.
  if (platform === 'darwin') return false;
  return enabled && !isQuitting && hasTray && otherVisibleWindows === 0;
}
