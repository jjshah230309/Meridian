#!/usr/bin/env node
// Meridian ERP :: scripts/service
// Install Meridian as a background service, so the office server runs it from
// boot without anybody logging in and leaving a terminal open.
//
// Three operating systems, three mechanisms, one command. Nothing is written
// outside the user's own account unless `--system` is passed, and every unit
// file is printed before it is installed so an administrator can see exactly
// what is about to run as them.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import url from 'node:url';
import { execFileSync } from 'node:child_process';
import * as appconfig from '../src/core/appconfig.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.meridian.erp.server';
const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const command = args.find((a) => !a.startsWith('--')) || 'status';

const nodeBin = process.execPath;
const entry = path.join(ROOT, 'src', 'server.mjs');
const dataDir = flag('data', path.join(ROOT, 'data'));
const port = flag('port', String(appconfig.readConfig(dataDir).server.port || 8422));
const logDir = flag('logs', path.join(dataDir, 'logs'));

const say = (...m) => console.log(...m);
const die = (m) => { console.error(`\n${m}\n`); process.exit(1); };

// ------------------------------------------------------------- macOS
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${entry}</string>
    <string>--server</string>
    <string>--data</string><string>${dataDir}</string>
    <string>--port</string><string>${port}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>StandardOutPath</key><string>${path.join(logDir, 'server.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'server.err.log')}</string>
</dict>
</plist>
`;

// ------------------------------------------------------------- Linux
const systemdPath = () => (flag('system')
  ? `/etc/systemd/system/meridian.service`
  : path.join(os.homedir(), '.config', 'systemd', 'user', 'meridian.service'));
const systemdUnit = () => `[Unit]
Description=Meridian ERP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodeBin} ${entry} --server --data ${dataDir} --port ${port}
WorkingDirectory=${ROOT}
Restart=always
RestartSec=5
# The database is the only thing worth protecting here, and it is the only
# thing outside the install the service needs to write.
ReadWritePaths=${dataDir}
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=${flag('system') ? 'multi-user.target' : 'default.target'}
`;

// ------------------------------------------------------------- Windows
const taskName = 'Meridian ERP Server';
const winScript = () => path.join(dataDir, 'meridian-server.vbs');
const winVbs = () => `' Starts the Meridian ERP server with no console window.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "${ROOT.replace(/\\/g, '\\\\')}"
sh.Run """${nodeBin.replace(/\\/g, '\\\\')}"" ""${entry.replace(/\\/g, '\\\\')}"" --server --data ""${dataDir.replace(/\\/g, '\\\\')}"" --port ${port}", 0, False
`;

// ------------------------------------------------------------ actions
function install() {
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  // Make sure the config on disk agrees with what the service will run, so a
  // later `--server` by hand behaves the same way.
  appconfig.writeConfig({ mode: 'server', server: { port: Number(port) } }, dataDir);

  if (process.platform === 'darwin') {
    const file = plistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, plist());
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, file], { stdio: 'inherit' });
    say(`\n· Installed ${file}`);
    say(`· Meridian will start at login and restart if it stops.`);
  } else if (process.platform === 'win32') {
    const script = winScript();
    fs.writeFileSync(script, winVbs());
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONSTART', '/RL', 'HIGHEST',
      '/TN', taskName, '/TR', `wscript.exe "${script}"`], { stdio: 'inherit' });
    say(`\n· Installed the scheduled task "${taskName}"`);
    say(`· Meridian will start with Windows.`);
  } else {
    const file = systemdPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemdUnit());
    const ctl = flag('system') ? ['systemctl'] : ['systemctl', '--user'];
    execFileSync(ctl[0], [...ctl.slice(1), 'daemon-reload'], { stdio: 'inherit' });
    execFileSync(ctl[0], [...ctl.slice(1), 'enable', '--now', 'meridian.service'], { stdio: 'inherit' });
    say(`\n· Installed ${file}`);
    if (!flag('system')) say('· Run "loginctl enable-linger $USER" so it runs without you logged in.');
  }
  say(`· Data:  ${dataDir}`);
  say(`· Logs:  ${logDir}`);
  say(`· Port:  ${port}\n`);
}

function uninstall() {
  if (process.platform === 'darwin') {
    try { execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    try { fs.unlinkSync(plistPath()); } catch { /* not there */ }
    say(`\n· Removed ${plistPath()}\n`);
  } else if (process.platform === 'win32') {
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', taskName], { stdio: 'inherit' }); } catch { /* not there */ }
    say(`\n· Removed the scheduled task "${taskName}"\n`);
  } else {
    const ctl = flag('system') ? ['systemctl'] : ['systemctl', '--user'];
    try { execFileSync(ctl[0], [...ctl.slice(1), 'disable', '--now', 'meridian.service'], { stdio: 'inherit' }); } catch { /* not enabled */ }
    try { fs.unlinkSync(systemdPath()); } catch { /* not there */ }
    say(`\n· Removed ${systemdPath()}\n`);
  }
  say('· Your data was left exactly where it is.\n');
}

function status() {
  const cfg = appconfig.readConfig(dataDir);
  say(`\nMeridian ERP service`);
  say(`  platform: ${process.platform}`);
  say(`  data:     ${dataDir}`);
  say(`  config:   ${cfg.$file}${cfg.$exists ? '' : ' (defaults — not written yet)'}`);
  say(`  mode:     ${cfg.mode}`);
  say(`  port:     ${cfg.server.port}`);
  if (process.platform === 'darwin') {
    say(`  unit:     ${plistPath()} ${fs.existsSync(plistPath()) ? '(installed)' : '(not installed)'}`);
  } else if (process.platform === 'win32') {
    say(`  task:     ${taskName}`);
  } else {
    say(`  unit:     ${systemdPath()} ${fs.existsSync(systemdPath()) ? '(installed)' : '(not installed)'}`);
  }
  say('');
}

function print() {
  if (process.platform === 'darwin') say(plist());
  else if (process.platform === 'win32') say(winVbs());
  else say(systemdUnit());
}

const usage = `
Meridian ERP — run it as a service

  node scripts/service.mjs install     install and start it
  node scripts/service.mjs uninstall   stop and remove it
  node scripts/service.mjs status      what is configured right now
  node scripts/service.mjs print       show the unit file without installing

Options
  --data <dir>   where the database lives     (default: ./data)
  --port <n>     which port to listen on      (default: from meridian.json, else 8422)
  --logs <dir>   where to write the log files (default: <data>/logs)
  --system       install for the whole machine rather than this account (Linux)
`;

try {
  ({ install, uninstall, status, print }[command] || (() => die(usage)))();
} catch (e) {
  die(`That did not work: ${e.message}`);
}
