# Cekai Link

A small Node.js client for workspace-bound questions through your local Codex CLI.
The standalone client is open source under Apache-2.0. Central is a separate service.

[中文接入指引](#中文接入指引) · [English](#install-and-first-use)

## 中文接入指引

通过 npm 安装部署方批准的精确版本，无需 clone 仓库；Mac、Windows、Linux 使用同一个 Node.js 包。以下命令以 `@cekaitech/cekai-link@1.0.0` 为例，执行前确认该版本已在 npm 发行且获目标 Central 准入。已有设备按部署方安排升级，保留原配置和配对，无需重新登记工作区。

### 1. 安装前准备

确认本机 Node.js 20+、Git 和单独安装的 Codex CLI 可用：

```sh
node --version
git --version
codex --version
```

还需使用自己的账号完成一次原生 Codex 问答。找到可执行文件不代表模型账号或额度可用；Link 不代装、登录或修改个人 Codex 配置。

向可信部署方取得 Central HTTPS 地址和自己的设备配对码。新 Central 支持 setup 自动获取精确兼容材料，无需传送文件或输入文件路径；离线或旧 Central 仍可使用部署方提供的匹配文件，放在项目和安装包之外。部署方需确认当前包已获 Central 准入；安装和下载材料本身不授予准入。

选择本机已有的工作目录。设备配对、工作区登记、聊天会话绑定是三个步骤；安装 Link 不会自动绑定目录或切换会话。

### 2. 安装并设置

Mac / Linux 使用当前用户可写的 npm global prefix，不为 Link 修改系统目录权限：

```sh
npm install --global --ignore-scripts @cekaitech/cekai-link@1.0.0
cekai-link setup
```

离线安装时，可将包名替换为部署方提供并核对摘要的原 tarball 路径。

Windows 在普通用户 PowerShell 使用 `.cmd`，无需修改全局执行策略：

```powershell
npm.cmd install --global --ignore-scripts @cekaitech/cekai-link@1.0.0
cekai-link.cmd setup
```

setup 先自校验安装包并检查 Codex，再询问可信 Central 地址。按精确包摘要获取、严格校验并原子保存在 Link 用户目录后，才隐藏询问配对码。请求不含凭据、配对码或工作区；拒绝重定向，10 秒超时、16 KiB 上限。失败时可输入部署方文件路径，或退出稍后重试，不消耗配对码。确认设备名称、自己选择的目录和登记操作；已配对设备沿用保存地址，有效兼容文件可离线复用，run 不后台下载或更新。

中途退出后重新运行 setup，会继续缺失步骤；配对成功但目录尚未登记时，不需重新配对。Windows 若找不到入口，可使用 npm prefix 中的正式命令：

```powershell
$LinkPrefix = (npm.cmd config get prefix).Trim()
& (Join-Path $LinkPrefix 'cekai-link.cmd') setup
```

### 3. 运行、绑定会话和提问

Mac / Linux 运行 `cekai-link run`，Windows 运行 `cekai-link.cmd run`，保持前台终端打开。在自己的目标机器人会话，按提示显式选择本机设备和工作区；setup 登记目录不会自动切换已有聊天会话。

另开终端运行 `cekai-link inspect --json`（Windows 为 `cekai-link.cmd inspect --json`）。整体应为 `ready`，设备已配对、工作区已登记、聊天绑定为 `active`，运行状态为 `running` / `fresh`，包完整性为 `verified`，Central 准入为 `accepted` 且可派发。未就绪时按 `nextAction` 操作。

在已绑定会话发送普通问题，例如“请只读概述当前工作区的用途。”不要求 `/agent`。确认收到回答和最终回执；安装成功或 inspect 就绪不能代替首次真实问答。

Ctrl+C 正常停止当前前台 Link，配置和登记保留。确认旧进程已退出且无待恢复任务后可再次 run，不需重新配对。也可在正常停止前台后，显式安装用户级后台服务，见下方说明；默认仍为前台运行，不自动更新。

### 4. 遇到问题时

| inspect 下一步 | 最小动作 |
| --- | --- |
| `configure-compatibility` | 重跑 setup 从可信 Central 获取；离线/旧 Central 使用部署方匹配文件 |
| `install-codex` / `diagnose-codex` | 先确认原生 Codex 可独立启动和问答，不猜账号或额度原因 |
| `bind-conversation` | 在自己的目标会话显式绑定本机设备和工作区 |
| `start-link` | 确认原进程已退出且无待恢复任务，再前台 run |
| `diagnose-central` / `retry-central-inspection` | 保留配对，核对网络和部署方准入，重新 inspect |
| `resolve-recovery` 或原进程持锁 | 先核对进程归属与执行、投递终态，不删锁或盲目重复任务 |
| `repair-local-configuration` | 保留配置、运行状态和锁，先核对文件与进程归属；状态损坏时确认 Central 终态后再恢复 |

可随时运行 `cekai-link --help` 查看首次接入步骤，或 `cekai-link --version` 核对安装包版本与源码身份；无参数也显示帮助。这些查询不读取个人 Link 配置、不连接 Central 或启动 Codex。`inspect`、`status`、`doctor` 只接受可选的单个 `--json`；未知或重复参数会明确失败并指向帮助。

显式 `CEKAI_LINK_COMPATIBILITY_PATH` 优先于已保存路径，错误覆盖不会自动回退。0.1.4 → 0.1.5 沿用配置格式，setup 获取或登记新包匹配材料，保留配对和工作区；回退需恢复升级前完整配置、原包、匹配文件及 Central 准入。旧 0.1.0 不能读取含 `compatibilityPath` 字段的新配置；不要恢复陈旧 runtime 或心跳序号。详见 [升级与回退](#015-background-service-and-upgrade)。

反馈实际失败时，只提供发生时间（含时区）、安装版本、可见错误类别、是否收到最终回执，以及 inspect 的状态和下一步。不发送配对码、配置文件、凭据、工作目录、问题或回答正文、原始日志。

### 5. 数据与执行边界

Link 固定绑定工作目录、`sandbox=read-only` 和 `approval_policy=never`，继承个人 Codex 的 Skills、MCP、model/provider 配置，不干预答案。Codex 对外部工具的规则继续生效；文件只读沙箱不保证外部 MCP 或网络工具没有副作用。

问题和回答会经过 Central 及用户配置的 Codex、模型或工具提供方；大屏脱敏不等于问答内容不传输。Central 接收确认后的设备名称（默认主机名）、工作区身份摘要、平台和任务生命周期事实，登记不上传工作目录或 Git remote；摘要仍可关联。Codex 可能保留本机会话数据。inspect 与大屏省略正文、路径、凭据和原始错误。

## Install and first use

Install the exact version approved by your deployment owner. The examples use `@cekaitech/cekai-link@1.0.0`; confirm that the version exists on npm and that your Central accepts it before installing. Mac, Windows and Linux use the same Node.js package; no repository clone is needed. Existing devices upgrade on the deployment owner's schedule and keep their configuration, pairing and workspace registration:

```sh
npm install --global --ignore-scripts @cekaitech/cekai-link@1.0.0
```

For offline installation, replace the package specifier with an owner-provided original tarball path and check its SHA256 against the trusted delivery record. Installing a package does not grant Central admission.

Use `npm.cmd` and `cekai-link.cmd` in Windows PowerShell. You do not need to change your global execution policy.

Before setup you need:

1. Node.js 20+ and a separately installed, working Codex CLI with your own account/configuration. Link does not install or log in to Codex. Git is needed for Git workspace identity.
2. A trusted deployment owner's HTTPS Central origin and pairing code. Setup downloads metadata for the exact installed package; offline or older servers still support an owner-provided matching file outside the package/workspace. Neither material grants admission.
3. A local workspace you choose, and an explicit binding in your target robot conversation. Workspace registration does not switch another user's conversation.

Run `cekai-link setup`, then `cekai-link run` in the foreground. Follow the next action from `cekai-link inspect`; explicitly bind the target conversation before asking questions. Natural-language questions do not require `/agent`. Keep the foreground terminal open; Ctrl+C stops only this Link. After a normal stop, optional current-user background execution is available below. There is no automatic update.

Setup self-checks the package and locates Codex, asks for the trusted Central origin, then downloads and validates exact compatibility metadata before collecting a hidden pairing code. It rejects redirects, limits reads to 10 seconds / 16 KiB, sends no credentials or workspace information, and atomically stores metadata in Link-owned state. A valid saved file works offline. Download failure offers the manual-file path without consuming a code or replacing working config. Paired devices keep their saved server; run never downloads updates:

```sh
cekai-link setup
cekai-link run
```

In Windows PowerShell:

```powershell
cekai-link.cmd setup
cekai-link.cmd run
```

An explicit `CEKAI_LINK_COMPATIBILITY_PATH` override wins and is revalidated; an invalid override never silently falls back. Executable detection proves Codex is located, not that account/model access works.

## 1.0 self-service lifecycle

1.0 keeps the same read-only questions, pairing, workspace and explicit chat binding. It adds a user-confirmed upgrade operation and shared lifecycle diagnosis. After the target Central has approved an exact published version, run:

```sh
cekai-link update 1.0.1
cekai-link update status
cekai-link update resume
cekai-link update rollback
```

`1.0.1` is an example, not a claim that this version exists or is approved. An absolute trusted original `.tgz` path can replace the version for offline delivery. `--yes` explicitly accepts the displayed lifecycle plan for trusted automation. The command downloads only the user-requested exact version from the official npm origin, verifies package content and the confirmed Central's exact compatibility metadata before stopping anything. No background polling, latest-based selection, install hooks, extra runtime dependencies or silent updates are used.

The original npm CLI remains the stable entry. New verified runtime files live in this configuration's owned version directory; the old installed files remain available. Use `--version` to see the effective selection. A normally stopped foreground Link stays foreground; an enabled service is normally stopped and restored, and a disabled service remains disabled. Pairing/workspace/chat identity and the current heartbeat are retained. The original service PATH/Codex home and executable locations are reused; shell-only secret variables are not persisted.

A failed or interrupted transition stays visible in `inspect` and `update status`. `update resume` rechecks the current Central and continues the same transaction. `update rollback` restores the retained package only when Central currently approves it; otherwise ask the deployment owner to restore compatible admission first. Unknown runtime locks and unconfirmed tasks are preserved and never replayed. Upgrade operation recovery does not authorize deleting task/runtime locks. Keep protected update materials until the deployment owner no longer needs recovery; they can contain your complete local configuration and must stay outside Git and your project.

**First move from 0.1.5:** use the deployment owner's coordinated npm installation of 1.0 and setup for the approved exact metadata; 0.1.5 has no updater. Once 1.0 is installed, keep its original npm entry for subsequent upgrades. The updater targets 1.x or later; a full return to 0.1.5 uses the retained original package/config/mapping and corresponding Central approval. Before npm uninstall, moving Node, or removing the original CLI installation, stop and uninstall the service normally. `service install --disabled` registers an optional service without enabling questions; use `service start` when ready.

中文：先确认部署方已批准目标精确版本，再运行 `cekai-link update <版本>`，确认显示的计划即可；可信离线包可用绝对路径代替版本。运行中的前台进程先正常Ctrl+C；已有后台服务由升级操作正常停止并恢复，原停用服务保持停用。`inspect` 与 `update status` 会给出下一步，中断使用 `update resume`；恢复旧版使用 `update rollback`，旧版也必须获当前Central准入。不要求用户编辑配置/锁文件，不重配对或重复任务。当前1.0仍须经过正式发行/生产批准后用于日常，源码构建不等于已发布。

## 0.1.5 background service and upgrade

Version 0.1.5 adds optional current-user background execution. The default foreground `run` remains available. Before using either mode, confirm that the exact package is published or supplied through a trusted delivery and approved by your Central; source build and npm installation alone do not grant admission.

0.1.5 增加可选的用户级后台运行和登录后启动。先完成 setup，正常停止已有前台 Link，并确认没有待恢复任务；再运行下方 service 命令。安装会立即启动后台 Link，关闭安装终端后继续工作。`stop` 会保持禁用，之后登录也不会自行恢复；用 `start` 显式恢复。`uninstall` 只移除服务，保留配对、工作区、兼容材料和心跳。

Mac 使用 LaunchAgent，Windows 使用当前用户普通权限计划任务，Linux 需要可用的用户 systemd；均不要求管理员权限或系统密码。服务不加载 shell 配置脚本，不保存临时导出的账号或代理凭据；保留个人 Codex 配置和工具，使用前确认实际问答可用。睡眠、注销或关机期间不承诺在线。

After setup, stop foreground run normally and confirm inspect has no pending recovery. In a supported logged-in user session:

```sh
cekai-link service install
cekai-link service status
cekai-link service stop
cekai-link service start
cekai-link service uninstall
```

On Windows use `cekai-link.cmd`. Install starts the existing runtime and registers a current-user logon trigger (macOS LaunchAgent, Windows limited interactive Scheduled Task, Linux user systemd). It requires no administrator elevation or account password. Closing the installer terminal does not stop the runtime. Stop persists a disabled intent, including across a later login; start explicitly re-enables it. Uninstall removes only the owned service registration and preserves pairing, workspace, compatibility, runtime and heartbeat. Before npm uninstall or moving/upgrading Node/the package, stop and uninstall the service first. No automatic updater or crash-restart loop is included.

The service runs in the same OS account with the saved executable search path and optional CODEX_HOME/Codex executable location, using the same personal Codex configuration, Skills and tools. It does not load `.zshrc`/PowerShell profiles or persist exported tokens, passwords, proxy credentials or arbitrary environment variables. Tools/providers that require shell-only secrets must obtain them through their normal user/session configuration; confirm a real question before switching daily use. Sleeping, logout and a powered-off computer cannot provide continuous Link availability. Linux requires an available user systemd manager; a plain Docker container is not such a session.

Service status reuses the existing inspect runtime/nextAction. A foreground owner, unconfirmed task, changed registration or leftover process/operation lock blocks automatic takeover. Preserve evidence and inspect before recovery; service commands never remove stale runtime locks or replay tasks. Raw subprocess errors are not copied to native service journals. The per-config service identity is separate from the internal/formal Link.

**Upgrade from 0.1.4:** in the deployment owner's coordinated window, confirm idle/no pending recovery, normally stop foreground Link and retain the exact 0.1.4 package, matching mapping and complete upgrade-time config. Install the approved 0.1.5 package and rerun setup to obtain its exact compatibility metadata. Pairing, workspace and explicit chat binding remain. Start in the foreground or explicitly opt into `service install`; setup does not install a service automatically.

**Rollback to 0.1.4:** while the 0.1.5 CLI is still available, normally stop and uninstall any 0.1.5 service first. Restore the original 0.1.4 package, matching mapping, complete upgrade-time config and corresponding Central approval together. Then use foreground run. Keep the current runtime and heartbeat sequence; never restore stale task state, remove locks or re-pair to force rollback. The service record is separate from the shared config format. Older recovery notes remain below.

## 0.1.4 changes and upgrade

Run `cekai-link`, `help`, `--help` or `-h` for offline usage, and `--version` or `-v` for the installed package version and source identity. These commands run before personal configuration is read and do not contact Central or start Codex. Package integrity checks remain in effect. Unknown or duplicate arguments fail with a help hint; existing valid commands and inspect JSON retain their format.

**Upgrade from 0.1.3:** in the deployment owner's coordinated window, confirm idle/no pending recovery, normally stop your foreground Link and preserve the complete upgrade-time config, original 0.1.3 package and matching mapping. Install the approved 0.1.4 package and run setup for its exact compatibility metadata. Pairing, workspace and explicit chat binding remain. Confirm inspect in a new terminal without a mapping override.

**Rollback to 0.1.3:** restore the original package, matching mapping, upgrade-time config and corresponding Central approval together. Preserve current runtime and heartbeat sequence; never delete locks, restore stale task state or re-pair to force recovery. The config format and read-only execution profile have not changed.

## 0.1.3 changes and upgrade

Setup obtains exact compatibility metadata from the confirmed Central origin before collecting a hidden pairing code. New installations no longer need a manually transferred file or its absolute path when Central supports bootstrap. Valid saved files work offline; explicit overrides and the manual-file fallback for older Central remain. Pairing, workspace registration and explicit chat binding retain their separate roles. Run does not download updates or change the user's Codex configuration.

**Upgrade from 0.1.2:** keep a complete config backup, original package and its matching mapping. In the deployment owner's coordinated window, confirm idle/no pending recovery and normally stop only your foreground Link. Install the reviewed 0.1.3 package, clear obsolete mapping overrides and rerun setup. Existing pairing/workspace data and the saved server remain; setup obtains the new exact mapping or offers the manual-file path. Inspect must work in a new terminal without a mapping environment override. A downloaded mapping still requires Central's exact active approval.

**Rollback to 0.1.2:** restore the original 0.1.2 package, its matching mapping, the complete upgrade-time config backup and corresponding Central approval. The shared config format is readable, but a 0.1.3 mapping cannot authorize 0.1.2. Keep the latest runtime and heartbeat sequence; never restore stale task state, remove locks or re-pair to force rollback. Older version recovery notes remain below.

## 0.1.2 changes and upgrade

Healthy polling preserves the running state instead of briefly reporting startup again. Inspect distinguishes a missing runtime file from a damaged one; damaged state requires inspection of process ownership and Central task/receipt facts before recovery. Stopping a task with an already-canceled Central request no longer leaves an unhandled promise rejection. Interrupted or unacknowledged tasks remain blocked for recovery rather than being executed again. No Codex prompt, personal configuration, permission or write capability changes are introduced.

**Upgrade from 0.1.1:** the config format is unchanged. In the deployment owner's coordinated window, confirm idle/no pending recovery, stop only your foreground Link normally and keep the original 0.1.1 tarball, matching mapping and a complete config backup. Install the exact 0.1.2 package, obtain its approved mapping and rerun setup to save that path. Pairing, workspace registration and explicit conversation binding are retained. Clear stale mapping environment overrides; a new terminal must pass inspect without one.

**Rollback to 0.1.1:** restore the original 0.1.1 package, its mapping, the upgrade-time config backup and matching Central approval. The older parser accepts the shared config format, but a mapping for 0.1.2 still cannot authorize 0.1.1. Keep the latest runtime and heartbeat sequence; never restore stale task state or remove locks to make an upgrade pass. Earlier 0.1.0 recovery remains documented below.

## 0.1.1 changes and upgrade

Setup and inspect now agree on prerequisites, save a validated compatibility-file path once, and distinguish missing Codex, connectivity/admission failures and interrupted tasks. Pairing and workspace registration still do not bind a robot conversation automatically. No service, automatic update or additional write capability is introduced.

For an existing 0.1.0 installation, follow the deployment owner's coordinated upgrade window. Stop your own foreground Link normally while idle, keep a private backup of its config and the original package/mapping, then install 0.1.1 in the same owned namespace. Obtain a mapping for the exact new package and Central release. Change or remove any old `CEKAI_LINK_COMPATIBILITY_PATH` override before setup; setup can then save the new path without pairing or workspace registration again. Never use a running Link's config for testing.

**Rollback:** old 0.1.0 cannot read the new optional `compatibilityPath` field. Restore the upgrade-time config backup, original 0.1.0 package and its matching mapping. Published 0.1.0 still requires `CEKAI_LINK_COMPATIBILITY_PATH` in each terminal. Central must also approve that original package for its active release; downgrading only the npm package is insufficient. Keep current runtime facts and heartbeat sequence; do not restore stale runtime files or remove locks/tasks to force recovery.

## Diagnose and recover

`cekai-link inspect --json` (also `status` / `doctor`) provides read-only facts and one next action. Missing compatibility, missing Codex, unavailable Central, incompatible admission and interrupted tasks are separate conditions. Preserve pairing when diagnosing connectivity. Do not infer model quota/provider failures without evidence.

Pairing survives a later workspace-step interruption; rerunning setup resumes the missing step. Runtime ownership is exclusive per config. Do not start a second instance or automatically remove a lock: confirm the owning process is gone and inspect task/receipt facts before recovering. An interrupted task is not permission to execute it again.

The default local namespace is `CekaiTech/cekai-link-public`, separate from private/formal Link. There is no automatic credential/workspace migration. Tests may use distinct absolute `CEKAI_LINK_PUBLIC_CONFIG_PATH` and `CEKAI_LINK_PUBLIC_RUNTIME_PATH`; keep config, runtime, locks, compatibility files and credentials outside Git. Setup collects pairing codes through hidden terminal input. Trusted automation may pipe a code with `pair --server <https-url> --code-stdin`; never put real codes in argv or shell history.

## Data and execution boundary

Link pins the bound working directory, `sandbox=read-only` and `approval_policy=never`. The user's normal Codex configuration, Skills and tools remain available under Codex's own rules. This is not a universal side-effect firewall for external MCP/network tools. Link does not add workspace-write commands or internal integrations, and does not edit project files.

Central receives the confirmed device name (default: hostname), workspace identity digests, OS/kind and task lifecycle facts. Workspace paths and Git remotes are not sent by registration; hashes remain correlatable. Question/answer contents transit through Central and the configured Codex/model/tool providers; dashboard redaction does not apply to this transport. Codex can retain its own local conversation data. Inspect and the dashboard omit raw failures, paths, credentials and task identities.

Build digests prove content consistency, not publisher authenticity or authorization. Trust the confirmed HTTPS origin or the manual delivery source; Central's exact approval remains required. The public bootstrap endpoint exposes only active approved version/digest metadata. Threads remain scoped by conversation binding and workspace identity.

## Build from source

This source targets version `1.0.0`. A clean source build is not a registry publication or production approval; use the exact released package accepted by your deployment owner for daily use.

```sh
npm ci --ignore-scripts
npm test
npm run build
npm pack
```

Development requires Node 20.19+, 22.12+ or 24+, Git and the locked TypeScript/Vitest toolchain. Build requires a clean committed tree and uses this standalone Git history. Building does not publish npm or grant server admission. The runtime has zero third-party production dependencies. Only `src/publicLink`, the minimal `src/adapters/publicLinkService` adapter, the public bootstrap/build tool and standalone metadata are included; private Central, channel adapters, internal MCP code, recovery artifacts and private history are excluded. CI publishing is a separate operator action.

## License

Copyright 2026 hkdijia. Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Node.js, Codex CLI, Git and development tools are separately installed, retain their own licenses and are not bundled.
Source: [hkdijia/cekai-link](https://github.com/hkdijia/cekai-link).
