import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { publicLinkServiceId, type PublicLinkServiceRecord } from '../../publicLink/serviceFiles.js';

export type PublicServiceState = 'active' | 'inactive' | 'absent' | 'unknown' | 'foreign';
export type ServiceExecute = (file: string, args: readonly string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;
export interface PublicLinkNativeService {
  query(): Promise<PublicServiceState>;
  install(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  uninstall(): Promise<void>;
}
const executeFile = promisify(execFile);

export function createPublicLinkNativeService(record: PublicLinkServiceRecord, input: {
  readonly platform?: NodeJS.Platform; readonly uid?: number; readonly execute?: ServiceExecute;
} = {}): PublicLinkNativeService {
  const platform = input.platform ?? process.platform;
  const execute = input.execute ?? (async (file, args, env) => executeFile(file, [...args], { env, timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true }));
  const id = publicLinkServiceId(record.configPath);
  const uid = input.uid ?? process.getuid?.();
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Link user service supports macOS, Windows and Linux');
  if (platform === 'darwin' && (!Number.isInteger(uid) || uid! <= 0)) throw new Error('A logged-in ordinary Mac user session is required');
  const args = [record.entryPath, 'service', 'host', '--config', record.configPath];
  const definition = renderPublicLinkService(record, platform);
  const definitionPath = platform === 'darwin' ? path.join(record.home, 'Library', 'LaunchAgents', `${id}.plist`)
    : path.join(record.home, '.config', 'systemd', 'user', `${id}.service`);
  const target = `gui/${uid}/${id}`;
  const windowsEnv = { ...process.env, CEKAI_PUBLIC_SERVICE_NAME: id, CEKAI_PUBLIC_SERVICE_NODE: record.nodePath,
    CEKAI_PUBLIC_SERVICE_ARGS: args.map(windowsArgument).join(' ') };
  const powershell = async (script: string) => execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], windowsEnv);
  const readDefinition = async () => {
    try {
      const details = await lstat(definitionPath);
      if (!details.isFile() || details.isSymbolicLink()) return 'foreign';
      return await readFile(definitionPath, 'utf8') === definition ? 'match' : 'foreign';
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
  };
  const query = async (): Promise<PublicServiceState> => {
    try {
      if (platform === 'win32') {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const result = await powershell(WINDOWS_QUERY);
            const value = result.stdout.trim();
            if (['active', 'inactive', 'absent', 'foreign'].includes(value)) return value as PublicServiceState;
          } catch { /* one fresh read may recover a transient native query failure */ }
          if (attempt === 0) await delay(200);
        }
        return 'unknown';
      }
      const fileState = await readDefinition();
      if (fileState === 'foreign') return 'foreign';
      if (platform === 'darwin') {
        try {
          const result = await execute('launchctl', ['print', target]);
          if (fileState === 'absent') return 'foreign';
          return /^\s*state = running\s*$/m.test(result.stdout) ? 'active' : 'inactive';
        } catch (error) {
          const failure = error as { stderr?: string; code?: number };
          if (/Could not find service|service not found/i.test(failure.stderr ?? '') && [3, 113].includes(Number(failure.code))) return 'absent';
          return 'unknown';
        }
      }
      const result = await execute('systemctl', ['--user', 'show', `${id}.service`, '--property=LoadState', '--property=ActiveState', '--no-pager']);
      if (/^LoadState=not-found$/m.test(result.stdout)) return 'absent';
      if (fileState === 'absent') return 'foreign';
      if (!/^LoadState=loaded$/m.test(result.stdout)) return 'unknown';
      return /^ActiveState=active$/m.test(result.stdout) ? 'active' : 'inactive';
    } catch { return 'unknown'; }
  };
  const assertOwned = async () => {
    const state = await query();
    if (state === 'unknown' || state === 'foreign') throw new Error('User service manager unavailable or registration ownership differs; no native action was performed');
    return state;
  };
  const install = async () => {
    const state = await assertOwned();
    if (platform === 'win32') {
      if (state === 'absent') await powershell(WINDOWS_INSTALL);
      return;
    }
    const fileState = await readDefinition();
    if (fileState === 'absent') {
      await mkdir(path.dirname(definitionPath), { recursive: true, mode: 0o700 });
      await writeFile(definitionPath, definition, { flag: 'wx', mode: 0o600 });
    } else if (fileState !== 'match') throw new Error('Link service definition differs; refusing replacement');
    if (platform === 'darwin') {
      if (state === 'absent') await execute('launchctl', ['bootstrap', `gui/${uid}`, definitionPath]);
    } else {
      await execute('systemctl', ['--user', 'daemon-reload']);
      await execute('systemctl', ['--user', 'enable', `${id}.service`]);
    }
  };
  return {
    query, install,
    async start() {
      await install();
      const state = await assertOwned();
      if (state === 'active') return;
      if (platform === 'darwin') await execute('launchctl', ['kickstart', target]);
      else if (platform === 'linux') await execute('systemctl', ['--user', 'start', `${id}.service`]);
      else await powershell('Start-ScheduledTask -TaskPath "\\" -TaskName $env:CEKAI_PUBLIC_SERVICE_NAME');
    },
    async stop() {
      const state = await assertOwned();
      if (state === 'absent') return;
      if (platform === 'darwin') await execute('launchctl', ['bootout', target]);
      else if (platform === 'linux') await execute('systemctl', ['--user', 'stop', `${id}.service`]);
      else if (state === 'active') await powershell('Stop-ScheduledTask -TaskPath "\\" -TaskName $env:CEKAI_PUBLIC_SERVICE_NAME');
    },
    async uninstall() {
      const state = await assertOwned();
      if (platform === 'win32') {
        if (state !== 'absent') await powershell('Unregister-ScheduledTask -TaskPath "\\" -TaskName $env:CEKAI_PUBLIC_SERVICE_NAME -Confirm:$false');
        return;
      }
      if (platform === 'darwin' && state !== 'absent') await execute('launchctl', ['bootout', target]);
      if (platform === 'linux') await execute('systemctl', ['--user', 'disable', '--now', `${id}.service`]);
      if (await readDefinition() === 'match') await rm(definitionPath);
      if (platform === 'linux') await execute('systemctl', ['--user', 'daemon-reload']);
    }
  };
}

/** User-session only; no automatic crash restart or raw output files. */
export function renderPublicLinkService(record: PublicLinkServiceRecord, platform: NodeJS.Platform): string {
  const id = publicLinkServiceId(record.configPath);
  const args = [record.nodePath, record.entryPath, 'service', 'host', '--config', record.configPath];
  if (platform === 'darwin') return [
    '<?xml version="1.0" encoding="UTF-8"?>', '<plist version="1.0"><dict>',
    `<key>Label</key><string>${id}</string>`,
    `<key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array>`,
    '<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>',
    '<key>ProcessType</key><string>Background</string>', '</dict></plist>\n'
  ].join('\n');
  if (platform === 'linux') return ['[Unit]', 'Description=Cekai Link public user worker', '[Service]', 'Type=exec',
    `ExecStart=${args.map(systemdArgument).join(' ')}`, 'Restart=no', 'TimeoutStopSec=20',
    'StandardOutput=null', 'StandardError=null', '[Install]', 'WantedBy=default.target', ''].join('\n');
  return JSON.stringify({ nodePath: record.nodePath, args: args.slice(1), trigger: 'current-user-logon', runLevel: 'Limited' });
}
const WINDOWS_TASK = '$tasks=@(Get-ScheduledTask -TaskPath "\\" -ErrorAction Stop | Where-Object { $_.TaskName -ceq $env:CEKAI_PUBLIC_SERVICE_NAME }); ';
const WINDOWS_QUERY = WINDOWS_TASK + [
  'if ($tasks.Count -eq 0) { "absent"; exit 0 }', 'if ($tasks.Count -ne 1) { "foreign"; exit 0 }',
  '$task=$tasks[0]; $identity=[Security.Principal.WindowsIdentity]::GetCurrent()',
  'try { $sid=([Security.Principal.NTAccount]::new($task.Principal.UserId)).Translate([Security.Principal.SecurityIdentifier]).Value; $triggerSid=([Security.Principal.NTAccount]::new($task.Triggers[0].UserId)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { "foreign"; exit 0 }',
  'if ($task.Actions.Count -ne 1 -or $task.Actions[0].Execute -ine $env:CEKAI_PUBLIC_SERVICE_NODE -or $task.Actions[0].Arguments -cne $env:CEKAI_PUBLIC_SERVICE_ARGS -or $sid -ne $identity.User.Value -or $task.Principal.RunLevel -ne "Limited" -or $task.Principal.LogonType -notin @("Interactive", "InteractiveToken") -or $task.Triggers.Count -ne 1 -or $task.Triggers[0].CimClass.CimClassName -ne "MSFT_TaskLogonTrigger" -or $triggerSid -ne $identity.User.Value) { "foreign"; exit 0 }',
  'if ($task.State -eq "Running") { "active" } else { "inactive" }'
].join('; ');
const WINDOWS_INSTALL = [
  '$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name',
  '$action=New-ScheduledTaskAction -Execute $env:CEKAI_PUBLIC_SERVICE_NODE -Argument $env:CEKAI_PUBLIC_SERVICE_ARGS',
  '$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited',
  '$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity',
  '$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew',
  'Register-ScheduledTask -TaskPath "\\" -TaskName $env:CEKAI_PUBLIC_SERVICE_NAME -Action $action -Principal $principal -Trigger $trigger -Settings $settings | Out-Null'
].join('; ');
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'); }
function systemdArgument(value: string): string { return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$$$')}"`; }
function windowsArgument(value: string): string { return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`; }

/** Local boot identity, never credentials or a user-provided command. */
export async function publicLinkBootIdentity(): Promise<string | undefined> {
  try {
    if (process.platform === 'linux') return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const result = process.platform === 'darwin'
      ? await executeFile('sysctl', ['-n', 'kern.bootsessionuuid'], { timeout: 10_000 })
      : await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ProgressPreference='SilentlyContinue'; (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks.ToString()"], { timeout: 15_000, windowsHide: true });
    const value = result.stdout.trim(); return /^[A-Za-z0-9-]{8,80}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
