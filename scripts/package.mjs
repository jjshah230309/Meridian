#!/usr/bin/env node
// Meridian ERP :: packaging
//
// Produces a self-contained, double-clickable distribution that needs
// nothing installed on the target machine:
//
//   macOS    dist/Meridian ERP.app          (a real .app bundle)
//   Windows  dist/Meridian ERP/             (with Meridian ERP.cmd)
//   Linux    dist/meridian-erp/             (with ./meridian)
//
// The Node runtime is bundled by fetching the official, statically linked
// build from nodejs.org. That matters: a package-manager Node (Homebrew, apt)
// is a thin binary dynamically linked against libraries that only exist on the
// build machine, so copying it produces a bundle that runs nowhere else.
// `--use-host-runtime` copies the running binary anyway for offline builds,
// and warns when it detects that the result will not be portable.
//
//   node scripts/package.mjs                 # this platform
//   node scripts/package.mjs --target win-x64
//   node scripts/package.mjs --target darwin-arm64 --target win-x64
//   node scripts/package.mjs --no-runtime    # app only, requires Node ≥22.5
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import zlib from 'node:zlib';
import { execFileSync, spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NODE_VERSION = process.version;                 // bundle the runtime we tested against
const APP_NAME = 'Meridian ERP';
const BUNDLE_ID = 'com.meridian.erp';

/** Files that make up the application itself. */
const APP_FILES = ['src', 'migrations', 'package.json', 'LICENSE', 'README.md'];

const args = process.argv.slice(2);
const targets = [];
let shareable = false;
let bundleRuntime = true;
let useHostRuntime = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--share') shareable = true;
  else if (args[i] === '--target') targets.push(args[++i]);
  else if (args[i].startsWith('--target=')) targets.push(args[i].split('=')[1]);
  else if (args[i] === '--no-runtime') bundleRuntime = false;
  else if (args[i] === '--use-host-runtime') useHostRuntime = true;
}
if (!targets.length) targets.push(hostTarget());

function hostTarget() {
  const plat = process.platform === 'win32' ? 'win' : process.platform;
  return `${plat}-${process.arch}`;
}

const log = (...a) => console.log('·', ...a);
const warn = (m) => console.warn(`! ${m}`);

// ------------------------------------------------------------ helpers
function copyTree(from, to, filter = () => true) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (!filter(entry)) continue;
      copyTree(path.join(from, entry), path.join(to, entry), filter);
    }
  } else {
    fs.copyFileSync(from, to);
    fs.chmodSync(to, stat.mode);
  }
}

const skip = (name) => ['node_modules', 'data', 'dist', '.git', '.DS_Store'].includes(name);

/** Fetch and unpack an official Node build for a non-host platform. */
async function fetchRuntime(target, into) {
  const [plat, arch] = target.split('-');
  const isWin = plat === 'win';
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const stem = `node-${NODE_VERSION}-${plat}-${arch}`;
  const file = isWin ? `${stem}.zip` : `${stem}.tar.gz`;
  const remote = `${base}/${file}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meridian-rt-'));
  const archive = path.join(tmp, file);

  log(`downloading ${remote}`);
  const res = await fetch(remote);
  if (!res.ok) throw new Error(`Could not download the Node runtime for ${target} (HTTP ${res.status}). Re-run with --no-runtime, or run this script on the target platform.`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));

  fs.mkdirSync(into, { recursive: true });
  if (isWin) {
    // `tar` on Windows and modern macOS both read zip archives.
    execFileSync('tar', ['-xf', archive, '-C', tmp]);
    fs.copyFileSync(path.join(tmp, stem, 'node.exe'), path.join(into, 'node.exe'));
  } else {
    execFileSync('tar', ['-xzf', archive, '-C', tmp]);
    const bin = path.join(into, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(path.join(tmp, stem, 'bin', 'node'), path.join(bin, 'node'));
    fs.chmodSync(path.join(bin, 'node'), 0o755);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/**
 * Copy the running interpreter. Only portable if that binary is statically
 * linked; a Homebrew or apt build is not, so say so rather than shipping a
 * bundle that dies on the user's machine.
 */
function copyHostRuntime(target, into) {
  const isWin = target.startsWith('win');
  if (isWin) {
    fs.mkdirSync(into, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(into, 'node.exe'));
  } else {
    const bin = path.join(into, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(bin, 'node'));
    fs.chmodSync(path.join(bin, 'node'), 0o755);
  }
  if (!isPortable(process.execPath)) {
    console.warn('  ! The Node binary on this machine is dynamically linked against');
    console.warn('    libraries outside the bundle, so this distribution will only run');
    console.warn('    here. Drop --use-host-runtime to fetch the portable official build.');
  }
  log(`bundled the running Node runtime (${NODE_VERSION})`);
}

/** Does this executable depend only on OS-provided libraries? */
function isPortable(binary) {
  if (process.platform === 'win32') return true;
  const tool = process.platform === 'darwin' ? 'otool' : 'ldd';
  const toolArgs = process.platform === 'darwin' ? ['-L', binary] : [binary];
  const out = spawnSync(tool, toolArgs, { encoding: 'utf8' });
  if (out.status !== 0 || !out.stdout) return true;                 // cannot tell; assume fine
  return !out.stdout.split('\n').slice(1).some((line) => {
    const p = line.trim().split(/\s/)[0];
    return p && !p.startsWith('/usr/lib') && !p.startsWith('/System/') && !p.startsWith('linux-vdso');
  });
}

async function placeRuntime(target, into) {
  if (!bundleRuntime) { log('skipping runtime — the distribution will require Node >= 22.5'); return false; }
  if (useHostRuntime && target === hostTarget()) { copyHostRuntime(target, into); return true; }
  await fetchRuntime(target, into);
  return true;
}

// ------------------------------------------------------------- macOS
async function buildMac(target) {
  const appDir = path.join(DIST, `${APP_NAME}.app`);
  fs.rmSync(appDir, { recursive: true, force: true });
  const contents = path.join(appDir, 'Contents');
  const macos = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });

  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) copyTree(src, path.join(resources, 'app', f), (n) => !skip(n));
  }
  const hasRuntime = await placeRuntime(target, path.join(resources, 'runtime'));

  fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>meridian</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.business</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <!-- The app is its own window: no Dock-less agent, no browser. -->
  <key>LSUIElement</key><false/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>NSSupportsSuddenTermination</key><false/>
  <!-- Loopback only; App Transport Security would otherwise block http://127.0.0.1 -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
`);

  buildMacIcon(resources);
  const launcherPath = path.join(macos, 'meridian');
  const native = buildMacHost(target, launcherPath);
  if (!native) {
    // No Swift compiler on this machine: fall back to a shell launcher that
    // starts the server and borrows a Chromium window. Say so, loudly --
    // the native host is the whole point of the bundle.
    warn('Swift compiler not found: falling back to a browser window. Install the Xcode Command Line Tools and rebuild for the native app.');
    fs.writeFileSync(launcherPath, `#!/bin/sh
set -e
HERE="$(cd "$(dirname "$0")/../Resources" && pwd)"
DATA="$HOME/Library/Application Support/Meridian"
mkdir -p "$DATA"
${hasRuntime ? 'NODE="$HERE/runtime/bin/node"' : 'NODE="$(command -v node || true)"'}
if [ ! -x "$NODE" ]; then
  osascript -e 'display alert "Meridian ERP" message "Node.js 22.5 or later is required for this build."' >/dev/null 2>&1 || true
  exit 1
fi
exec "$NODE" "$HERE/app/src/server.mjs" --data "$DATA" >> "$DATA/meridian.log" 2>&1
`);
    fs.chmodSync(launcherPath, 0o755);
  }

  // Ad-hoc sign so Gatekeeper on Apple Silicon will run it locally.
  const signed = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'ignore' });
  log(`macOS bundle: ${appDir}${signed.status === 0 ? ' (ad-hoc signed)' : ''}`);
  return appDir;
}

/**
 * Compile the native Cocoa host. This is what makes the bundle an app rather
 * than a shortcut to a browser: it owns a WKWebView and runs the server as
 * its own child process.
 */
function buildMacHost(target, outPath) {
  const source = path.join(ROOT, 'native/macos/main.swift');
  if (!fs.existsSync(source)) return false;
  const swiftc = spawnSync('xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (swiftc.status !== 0) return false;

  // Invoking the compiler by absolute path skips the SDK that `xcrun swiftc`
  // would have injected, so pass it explicitly or the standard library will
  // not load.
  const sdk = spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' });
  if (sdk.status !== 0) return false;

  const arch = target.split('-')[1] === 'x64' ? 'x86_64' : 'arm64';
  const built = spawnSync(swiftc.stdout.trim(), [
    '-O', '-whole-module-optimization',
    '-sdk', sdk.stdout.trim(),
    '-target', `${arch}-apple-macos12.0`,
    '-framework', 'AppKit', '-framework', 'WebKit',
    '-o', outPath, source,
  ], { encoding: 'utf8' });

  if (built.status !== 0) {
    warn(`Swift build failed:\n${(built.stderr || '').trim().split('\n').slice(0, 6).join('\n')}`);
    return false;
  }
  fs.chmodSync(outPath, 0o755);
  log(`native host: ${arch} (WKWebView, no browser needed)`);
  return true;
}

/**
 * Render the app icon into the .icns the Finder and Dock read. Drawn here
 * rather than checked in as a binary, so the whole build stays inspectable.
 */
function buildMacIcon(resources) {
  const iconset = path.join(os.tmpdir(), `meridian-${process.pid}.iconset`);
  fs.rmSync(iconset, { recursive: true, force: true });
  fs.mkdirSync(iconset, { recursive: true });

  // A rounded slab with the wordmark "M", in the app's accent blue.
  const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4b8ef1"/><stop offset="1" stop-color="#2f66c8"/>
    </linearGradient>
  </defs>
  <rect x="34" y="34" width="444" height="444" rx="100" fill="url(#g)"/>
  <path d="M136 356V170h44l76 116 76-116h44v186h-44V246l-58 89h-36l-58-89v110z" fill="#fff"/>
</svg>`;

  let made = 0;
  for (const size of [16, 32, 64, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const px = size * scale;
      if (px > 1024) continue;
      const svgPath = path.join(iconset, `tmp-${px}.svg`);
      fs.writeFileSync(svgPath, svg(px));
      const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
      const conv = spawnSync('rsvg-convert', ['-w', String(px), '-h', String(px), svgPath, '-o', path.join(iconset, name)], { stdio: 'ignore' });
      if (conv.status !== 0) {
        // No rsvg on a stock Mac; sips reads SVG on recent macOS.
        const sips = spawnSync('sips', ['-s', 'format', 'png', '-z', String(px), String(px),
          svgPath, '--out', path.join(iconset, name)], { stdio: 'ignore' });
        if (sips.status !== 0) { fs.rmSync(svgPath, { force: true }); continue; }
      }
      fs.rmSync(svgPath, { force: true });
      made++;
    }
  }
  if (!made) { fs.rmSync(iconset, { recursive: true, force: true }); return false; }

  const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')], { stdio: 'ignore' });
  fs.rmSync(iconset, { recursive: true, force: true });
  return icns.status === 0;
}

// ----------------------------------------------------------- Windows
async function buildWindows(target) {
  const outDir = path.join(DIST, APP_NAME);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) copyTree(src, path.join(outDir, 'app', f), (n) => !skip(n));
  }
  const hasRuntime = await placeRuntime(target, path.join(outDir, 'runtime'));

  buildWindowsIcon(outDir);

  // The launcher owns the whole session: it starts the server hidden, waits
  // for the port it settled on, opens a chromeless window on it, and shuts the
  // server down when that window closes. Nothing here shows a console.
  const launcher = [
    '# Meridian ERP launcher.',
    '#',
    '# Windows has no bundled native web host we can ship against, so the UI',
    '# runs in Edge/WebView2 "app mode": a plain window with no tabs and no',
    '# address bar, on its own profile so it is a separate taskbar entry.',
    '# Edge is part of Windows 10 and 11, so this needs nothing installed.',
    '$ErrorActionPreference = "Stop"',
    '$here = Split-Path -Parent $MyInvocation.MyCommand.Definition',
    '$data = Join-Path $env:LOCALAPPDATA "Meridian"',
    'New-Item -ItemType Directory -Force -Path $data | Out-Null',
    '',
    'function Show-Message($text) {',
    '  Add-Type -AssemblyName PresentationFramework',
    '  [System.Windows.MessageBox]::Show($text, "Meridian ERP") | Out-Null',
    '}',
    '',
    '$node = Join-Path $here "runtime\\node.exe"',
    'if (-not (Test-Path $node)) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }',
    'if (-not $node) {',
    '  Show-Message "This copy of Meridian is missing its Node runtime, and Node is not installed."',
    '  exit 1',
    '}',
    '',
    '# Start fresh each launch, keeping one previous log: otherwise the port',
    '# from a past session is still sitting in the file and we would open a',
    '# window on a server that is no longer there.',
    '$log = Join-Path $data "meridian.log"',
    '$errLog = Join-Path $data "meridian.err.log"',
    'if (Test-Path $log) { Move-Item -Force $log (Join-Path $data "meridian.prev.log") }',
    '',
    '# --port 0 lets the OS choose, so two copies never collide.',
    '$serverArgs = @((Join-Path $here "app\\src\\server.mjs"), "--data", $data, "--port", "0", "--no-open")',
    '# -NoNewWindow, not -WindowStyle Hidden: redirecting output forces',
    '# UseShellExecute off, and -WindowStyle requires it on. The parent',
    '# console is already hidden by the .vbs, so the child inherits that.',
    '$server = Start-Process -FilePath $node -ArgumentList $serverArgs -NoNewWindow -PassThru `',
    '  -RedirectStandardOutput $log -RedirectStandardError $errLog',
    '',
    '# Wait for the server to announce the address it settled on. Reading the',
    '# log rather than a pipe means nothing can block on a full buffer.',
    '$url = $null',
    '$deadline = (Get-Date).AddSeconds(120)',
    'while (-not $url -and (Get-Date) -lt $deadline) {',
    '  if (Test-Path $log) {',
    '    $hit = Select-String -Path $log -Pattern "^MERIDIAN_READY (.+)$" -ErrorAction SilentlyContinue | Select-Object -First 1',
    '    if ($hit) { $url = $hit.Matches[0].Groups[1].Value.Trim() }',
    '  }',
    '  if (-not $url) {',
    '    if ($server.HasExited) { break }',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    '}',
    '',
    'if (-not $url) {',
    '  $tail = @()',
    '  foreach ($f in @($errLog, $log)) { if (Test-Path $f) { $tail += Get-Content $f -Tail 6 } }',
    '  Show-Message ("Meridian could not start.`n`n" + ($tail -join "`n") + "`n`nFull log: $log")',
    '  if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }',
    '  exit 1',
    '}',
    '',
    '$browsers = @(',
    '  "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",',
    '  "${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",',
    '  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",',
    '  "${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",',
    '  "$env:ProgramFiles\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"',
    ')',
    '$exe = $browsers | Where-Object { Test-Path $_ } | Select-Object -First 1',
    'if (-not $exe) {',
    '  Show-Message "Meridian needs Microsoft Edge, which is part of Windows, to draw its window. It could not be found, so the app has been opened in your default browser instead."',
    '  Start-Process $url',
    '  $server.WaitForExit()',
    '  exit 0',
    '}',
    '',
    '# A dedicated profile directory is what makes this its own window and its',
    '# own taskbar item rather than another tab in whatever is already open.',
    '$profileDir = Join-Path $data "window"',
    '$windowArgs = @(',
    '  "--app=$url",',
    '  "--user-data-dir=$profileDir",',
    '  "--window-size=1440,920",',
    '  "--no-first-run",',
    '  "--no-default-browser-check",',
    '  "--disable-features=Translate,DefaultBrowserPrompt"',
    ')',
    '$window = Start-Process -FilePath $exe -ArgumentList $windowArgs -PassThru',
    '',
    '# When the window closes, stop the server: no stray background process.',
    '# Windows has no SIGTERM, so this is a hard stop -- safe here because the',
    '# database is journalled and every committed write is already durable.',
    '$window.WaitForExit()',
    'Start-Sleep -Milliseconds 400',
    'if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }',
  ].join('\r\n');
  fs.writeFileSync(path.join(outDir, 'launcher.ps1'), launcher);

  // Double-clicked entry point. wscript runs the launcher with no console
  // window at all, which a .cmd cannot do.
  fs.writeFileSync(path.join(outDir, `${APP_NAME}.vbs`), [
    "' Starts Meridian ERP with no console window.",
    'Set shell = CreateObject("WScript.Shell")',
    'here = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)',
    'shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & here & "\\launcher.ps1""", 0, False',
  ].join('\r\n'));

  // Kept for anyone who wants to watch it start, or run it from a terminal.
  fs.writeFileSync(path.join(outDir, `${APP_NAME}.cmd`),
    ['@echo off',
      'rem Same launcher, with the console left visible for troubleshooting.',
      'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher.ps1"',
    ].join('\r\n'));

  fs.writeFileSync(path.join(outDir, 'Create Shortcut.ps1'), [
    '# Adds Meridian ERP to the Start menu and the desktop.',
    '$here = Split-Path -Parent $MyInvocation.MyCommand.Definition',
    '$shell = New-Object -ComObject WScript.Shell',
    'foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {',
    '  $lnk = $shell.CreateShortcut((Join-Path $dir "Meridian ERP.lnk"))',
    '  $lnk.TargetPath = Join-Path $here "Meridian ERP.vbs"',
    '  $lnk.WorkingDirectory = $here',
    '  $lnk.Description = "Meridian ERP"',
    '  $icon = Join-Path $here "meridian.ico"',
    '  if (Test-Path $icon) { $lnk.IconLocation = $icon }',
    '  $lnk.Save()',
    '}',
    'Write-Host "Meridian ERP added to the Start menu and desktop."',
  ].join('\r\n'));

  log(`Windows folder: ${outDir}`);
  return outDir;
}

/**
 * Write a Windows .ico for the shortcut. An .ico is a tiny container: a
 * 6-byte header, one 16-byte directory entry per size, then the images. PNG
 * payloads are legal from Windows Vista onward, so the PNGs `sips` already
 * produced can be embedded whole.
 */
function buildWindowsIcon(outDir) {
  const tmp = path.join(os.tmpdir(), `meridian-ico-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const svgPath = path.join(tmp, 'icon.svg');
  fs.writeFileSync(svgPath, `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#4b8ef1"/><stop offset="1" stop-color="#2f66c8"/>
  </linearGradient></defs>
  <rect x="34" y="34" width="444" height="444" rx="100" fill="url(#g)"/>
  <path d="M136 356V170h44l76 116 76-116h44v186h-44V246l-58 89h-36l-58-89v110z" fill="#fff"/>
</svg>`);

  const images = [];
  for (const size of [16, 32, 48, 64, 128, 256]) {
    const png = path.join(tmp, `${size}.png`);
    const ok = spawnSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size),
      svgPath, '--out', png], { stdio: 'ignore' }).status === 0
      || spawnSync('rsvg-convert', ['-w', String(size), '-h', String(size), svgPath, '-o', png], { stdio: 'ignore' }).status === 0;
    if (ok && fs.existsSync(png)) images.push({ size, data: fs.readFileSync(png) });
  }
  if (!images.length) { fs.rmSync(tmp, { recursive: true, force: true }); return false; }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);              // reserved
  header.writeUInt16LE(1, 2);              // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const img of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0);   // 0 means 256
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1);
    e.writeUInt8(0, 2);                    // palette entries
    e.writeUInt8(0, 3);                    // reserved
    e.writeUInt16LE(1, 4);                 // colour planes
    e.writeUInt16LE(32, 6);                // bits per pixel
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += img.data.length;
  }

  fs.writeFileSync(path.join(outDir, 'meridian.ico'),
    Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
  fs.rmSync(tmp, { recursive: true, force: true });
  return true;
}

/**
 * Zip a bundle for handover. `ditto` is used rather than `zip` because it
 * preserves the code signature and resource forks; a bundle zipped any other
 * way arrives on the other Mac reporting itself as damaged.
 */
function archive(target, label) {
  const out = path.join(DIST, `${label}.zip`);
  fs.rmSync(out, { force: true });
  const args = target.endsWith('.app')
    ? ['-c', '-k', '--sequesterRsrc', '--keepParent', target, out]
    : ['-c', '-k', '--keepParent', target, out];
  const r = spawnSync('ditto', args, { stdio: 'ignore' });
  if (r.status !== 0) { warn(`Could not archive ${label}`); return null; }
  const mb = (fs.statSync(out).size / 1e6).toFixed(1);
  log(`archive: ${out} (${mb} MB)`);
  return out;
}

/**
 * The note that travels with the app. Anyone handed an unsigned Mac build
 * hits Gatekeeper, and without this they conclude the app is broken.
 */
function handoverNotes() {
  return [
    'Meridian ERP',
    '============',
    '',
    'A complete ERP that runs entirely on your own machine. Nothing is sent',
    'anywhere, there is no account to create online, and no internet',
    'connection is needed after you have the file.',
    '',
    '',
    'macOS',
    '-----',
    '1. Unzip "Meridian ERP.zip" and drag "Meridian ERP.app" to Applications.',
    '2. Double-click it.',
    '',
    'If macOS says the app "cannot be opened" or "is not from an identified',
    'developer", that is because this is an internal build that has not been',
    'through Apple notarisation. It is expected, and here is the one-time fix:',
    '',
    '   Open System Settings > Privacy & Security, scroll to the bottom,',
    '   and next to the message about Meridian ERP click "Open Anyway".',
    '   Confirm, and it will open normally from then on.',
    '',
    'You will not see that message at all if the app was copied to your Mac',
    'from a USB stick or a shared folder rather than downloaded or AirDropped.',
    '',
    '',
    'Windows',
    '-------',
    '1. Unzip the folder somewhere permanent, such as your Documents.',
    '2. Double-click "Meridian ERP.vbs".',
    '3. Optional: right-click "Create Shortcut.ps1" and choose "Run with',
    '   PowerShell" to add it to the Start menu and desktop.',
    '',
    'If SmartScreen warns you, choose "More info" then "Run anyway" -- same',
    'reason as above: an internal build with no purchased code-signing',
    'certificate.',
    '',
    '',
    'First run',
    '---------',
    'The app opens its own window and asks you to set up a company: its name,',
    'country, currency and your administrator account. It takes a minute.',
    '',
    'There is a tick-box for sample data. Turning it on loads six months of',
    'invented trading history -- customers, stock, invoices, projects,',
    'payroll -- so that every screen has something in it. That is usually the',
    'right choice for a first look. Leave it off to start on real books.',
    '',
    'Whatever you choose, it is your company: your name, your currency, your',
    'password.',
    '',
    '',
    'Where your data lives',
    '---------------------',
    'macOS    ~/Library/Application Support/Meridian',
    'Windows  %LOCALAPPDATA%\\Meridian',
    '',
    'One SQLite file holds everything. Copy it to back it up; delete the',
    'folder to start completely over.',
    '',
    '',
    'Notes',
    '-----',
    '* The app is self-contained. It does not install anything, does not need',
    '  Node or a database, and does not run in the background once closed.',
    '* Closing the window stops the service.',
    '* On macOS the window is the application itself. On Windows it borrows',
    '  the Edge web engine that ships with Windows, which is why there is no',
    '  separate download.',
  ].join('\n');
}

// ------------------------------------------------------------- Linux
async function buildLinux(target) {
  const outDir = path.join(DIST, 'meridian-erp');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of APP_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) copyTree(src, path.join(outDir, 'app', f), (n) => !skip(n));
  }
  const hasRuntime = await placeRuntime(target, path.join(outDir, 'runtime'));
  const sh = `#!/bin/sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
DATA="\${XDG_DATA_HOME:-$HOME/.local/share}/meridian"
mkdir -p "$DATA"
${hasRuntime ? 'NODE="$HERE/runtime/bin/node"' : 'NODE="$(command -v node)"'}
exec "$NODE" "$HERE/app/src/server.mjs" --data "$DATA" "$@"
`;
  fs.writeFileSync(path.join(outDir, 'meridian'), sh);
  fs.chmodSync(path.join(outDir, 'meridian'), 0o755);
  log(`Linux folder: ${outDir}`);
  return outDir;
}

// -------------------------------------------------------------- main
async function main() {
  let archived = false;
  fs.mkdirSync(DIST, { recursive: true });
  console.log(`\nPackaging ${APP_NAME} ${pkg.version} (runtime ${NODE_VERSION})\n`);

  for (const target of targets) {
    log(`target: ${target}`);
    let out;
    if (target.startsWith('darwin')) out = await buildMac(target);
    else if (target.startsWith('win')) out = await buildWindows(target);
    else if (target.startsWith('linux')) out = await buildLinux(target);
    else throw new Error(`Unknown target "${target}". Use darwin-arm64, darwin-x64, win-x64 or linux-x64.`);

    const size = du(out);
    log(`done — ${(size / 1024 / 1024).toFixed(1)} MB`);

    if (shareable) {
      // The note has to travel inside the archive, and a .app bundle is the
      // one target with nowhere to put it — there it ships beside the zip.
      if (fs.statSync(out).isDirectory() && !out.endsWith('.app')) {
        fs.writeFileSync(path.join(out, 'Read me first.txt'), handoverNotes());
      }
      archive(out, target.startsWith('win') ? `${APP_NAME} (Windows)` : APP_NAME);
      archived = true;
    }
  }

  if (shareable) {
    fs.writeFileSync(path.join(DIST, 'Read me first.txt'), handoverNotes());
  }

  console.log(`\nDistributions are in ${DIST}\n`);
  console.log('macOS   double-click "Meridian ERP.app" (or drag it to /Applications).');
  console.log('        A native window — no browser involved, nothing to install.');
  console.log('Windows double-click "Meridian ERP.vbs", then run "Create Shortcut.ps1" once');
  console.log('        to add it to the Start menu and desktop.');
  console.log('Both keep their data in the user profile and stop the service on quit.');
  if (archived) {
    console.log('\nTo hand it to someone: send the .zip together with "Read me first.txt".');
    console.log('The Mac build is ad-hoc signed, so on their machine it needs one pass');
    console.log('through System Settings > Privacy & Security > "Open Anyway". The note');
    console.log('explains that. Copying it from a USB stick avoids the prompt entirely.');
  } else {
    console.log('\nAdd --share to also produce zips and a handover note.');
  }
  console.log('');
}

function du(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(target).reduce((a, e) => a + du(path.join(target, e)), 0);
}

main().catch((e) => { console.error('\nPackaging failed:', e.message, '\n'); process.exit(1); });
