// Meridian ERP :: core/desktop
// Opening the application window.
//
// Meridian is a desktop application. The fact that it happens to be built on
// a local HTTP server is an implementation detail, and this module's job is
// to keep it one: whatever is available on this machine, the user gets a
// window with their accounts in it, not a browser tab pointed at localhost.
//
// The order of preference is deliberate. A real native host owns its own
// window, menus and keyboard shortcuts, so it wins. Failing that a Chromium
// app window has no address bar, no tabs and no bookmarks bar, which is much
// closer to an application than a browser is. The ordinary browser is the
// last resort, and is announced as such.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/**
 * Where a packaged native host might be found, best first.
 *
 * The build in the project's own `dist` is listed last and marked, because
 * handing over to it means running the code as it was when it was packaged.
 * That is right for somebody using Meridian and wrong for somebody changing
 * it, so the caller decides.
 */
function nativeHosts(root) {
  if (process.platform === 'darwin') {
    return [
      { path: '/Applications/Meridian ERP.app', installed: true },
      { path: path.join(os.homedir(), 'Applications', 'Meridian ERP.app'), installed: true },
      { path: path.join(root, 'dist', 'Meridian ERP.app'), installed: false },
    ];
  }
  if (process.platform === 'win32') {
    return [
      { path: path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Meridian ERP', 'Meridian ERP.vbs'), installed: true },
      { path: path.join(root, 'dist', 'Meridian ERP', 'Meridian ERP.vbs'), installed: false },
    ];
  }
  return [];
}

const CHROMIUM = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  win32: [
    `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ],
  linux: ['google-chrome', 'chromium', 'microsoft-edge', 'chromium-browser'],
};

const detach = (cmd, args) => {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  return child;
};

/**
 * Is a packaged native host installed on this machine?
 *
 * Reported separately from opening one, because the launcher has to decide
 * whether to start a server at all: the native host starts its own.
 */
export function findNativeHost(root, { installedOnly = false } = {}) {
  for (const candidate of nativeHosts(root)) {
    if (installedOnly && !candidate.installed) continue;
    try { if (fs.existsSync(candidate.path)) return candidate.path; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Open the window.
 *
 * Returns how it was opened, so the caller can say something useful rather
 * than leaving the user staring at a terminal wondering what happened.
 */
export function openWindow(appUrl, { root, preferNative = false, installedOnly = true, windowSize = '1560,980' } = {}) {
  if (preferNative) {
    const native = findNativeHost(root, { installedOnly });
    if (native) {
      try {
        if (process.platform === 'darwin') { detach('open', ['-a', native]); return { how: 'native', path: native }; }
        detach('wscript.exe', [native]);
        return { how: 'native', path: native };
      } catch { /* fall through to a browser window */ }
    }
  }

  const profileDir = path.join(os.tmpdir(), 'meridian-window');
  const appArgs = [
    `--app=${appUrl}`, `--user-data-dir=${profileDir}`,
    `--window-size=${windowSize}`, '--no-first-run', '--no-default-browser-check',
  ];
  for (const candidate of CHROMIUM[process.platform] || CHROMIUM.linux) {
    try {
      if (process.platform !== 'linux' && !fs.existsSync(candidate)) continue;
      detach(candidate, appArgs);
      return { how: 'app-window', path: candidate };
    } catch { /* try the next one */ }
  }

  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', appUrl] : [appUrl];
    detach(cmd, args);
    return { how: 'browser' };
  } catch { return { how: 'none' }; }
}

/** Every address this machine can be reached on, for a server to print. */
export function lanAddresses(port, tls = false) {
  const scheme = tls ? 'https' : 'http';
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const nic of entries || []) {
      if (nic.internal || nic.family !== 'IPv4') continue;
      out.push(`${scheme}://${nic.address}:${port}/`);
    }
  }
  return out;
}
