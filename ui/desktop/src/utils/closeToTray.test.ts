import { describe, expect, it } from 'vitest';
import { shouldHideOnClose, type CloseToTrayInput } from './closeToTray';

const base: CloseToTrayInput = {
  enabled: true,
  isQuitting: false,
  hasTray: true,
  platform: 'win32',
  otherVisibleWindows: 0,
};

describe('shouldHideOnClose', () => {
  it('hides the last visible window to the tray', () => {
    expect(shouldHideOnClose(base)).toBe(true);
    expect(shouldHideOnClose({ ...base, platform: 'linux' })).toBe(true);
  });

  it('closes for real when the setting is off', () => {
    expect(shouldHideOnClose({ ...base, enabled: false })).toBe(false);
  });

  it('closes for real during a quit, update install or shutdown', () => {
    expect(shouldHideOnClose({ ...base, isQuitting: true })).toBe(false);
  });

  it('closes for real when there is no tray icon to bring the window back', () => {
    expect(shouldHideOnClose({ ...base, hasTray: false })).toBe(false);
  });

  it('closes extra windows while another one is still visible', () => {
    expect(shouldHideOnClose({ ...base, otherVisibleWindows: 1 })).toBe(false);
  });

  it('leaves macOS alone', () => {
    expect(shouldHideOnClose({ ...base, platform: 'darwin' })).toBe(false);
  });
});
