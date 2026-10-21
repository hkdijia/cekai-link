# Cekai Link

A small Node.js client for workspace-bound questions through your local Codex CLI.
The standalone client is open source under Apache-2.0. Central is a separate service.

[中文接入指引](#中文接入指引) · [English](#install-and-first-use)

## 中文接入指引

本轮为接入简化的本地候选，尚未发行 npm；仅使用部署方核对的同字节 tarball 隔离验收。已正常运行 0.1.2 的用户继续使用原包。无需 clone 仓库，Mac、Windows、Linux 使用同一个 Node.js 包。

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
npm install --global --ignore-scripts /absolute/path/to/reviewed-link.tgz
cekai-link setup
```

Windows 在普通用户 PowerShell 使用 `.cmd`，无需修改全局执行策略：

```powershell
npm.cmd install --global --ignore-scripts C:\reviewed\link.tgz
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

Ctrl+C 正常停止当前前台 Link，配置和登记保留。确认旧进程已退出且无待恢复任务后可再次 run，不需重新配对。当前版本没有自动后台服务或自动更新。

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

显式 `CEKAI_LINK_COMPATIBILITY_PATH` 优先于已保存路径，错误覆盖不会自动回退。0.1.1 → 0.1.2 沿用配置格式，setup 更新匹配兼容文件路径，保留配对和工作区；回退需恢复升级前配置、原包、匹配文件及 Central 准入。旧 0.1.0 不能读取含新增 `compatibilityPath` 字段的新配置；不要恢复陈旧 runtime 或心跳序号。详见 [升级与回退](#012-changes-and-upgrade)。

反馈实际失败时，只提供发生时间（含时区）、安装版本、可见错误类别、是否收到最终回执，以及 inspect 的状态和下一步。不发送配对码、配置文件、凭据、工作目录、问题或回答正文、原始日志。

### 5. 数据与执行边界

Link 固定绑定工作目录、`sandbox=read-only` 和 `approval_policy=never`，继承个人 Codex 的 Skills、MCP、model/provider 配置，不干预答案。Codex 对外部工具的规则继续生效；文件只读沙箱不保证外部 MCP 或网络工具没有副作用。

问题和回答会经过 Central 及用户配置的 Codex、模型或工具提供方；大屏脱敏不等于问答内容不传输。Central 接收确认后的设备名称（默认主机名）、工作区身份摘要、平台和任务生命周期事实，登记不上传工作目录或 Git remote；摘要仍可关联。Codex 可能保留本机会话数据。inspect 与大屏省略正文、路径、凭据和原始错误。

## Install and first use

This is a local onboarding candidate, not an npm release. Use only an owner-reviewed tarball for isolated acceptance. Existing 0.1.2 users keep their running package:

```sh
npm install --global --ignore-scripts /absolute/path/to/reviewed-link.tgz
```

Check the original tarball SHA256 against the trusted delivery record. Installing a package does not grant Central admission.

Use `npm.cmd` and `cekai-link.cmd` in Windows PowerShell. You do not need to change your global execution policy.

Before setup you need:

1. Node.js 20+ and a separately installed, working Codex CLI with your own account/configuration. Link does not install or log in to Codex. Git is needed for Git workspace identity.
2. A trusted deployment owner's HTTPS Central origin and pairing code. Setup downloads metadata for the exact installed package; offline or older servers still support an owner-provided matching file outside the package/workspace. Neither material grants admission.
3. A local workspace you choose, and an explicit binding in your target robot conversation. Workspace registration does not switch another user's conversation.

Run `cekai-link setup`, then `cekai-link run` in the foreground. Follow the next action from `cekai-link inspect`; explicitly bind the target conversation before asking questions. Natural-language questions do not require `/agent`. Keep the foreground terminal open; Ctrl+C stops only this Link. There is no automatic service or update.

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

```sh
npm ci --ignore-scripts
npm test
npm run build
npm pack
```

Development requires Node 20.19+, 22.12+ or 24+, Git and the locked TypeScript/Vitest toolchain. Build requires a clean committed tree and uses this standalone Git history. Building does not publish npm or grant server admission. The runtime has zero third-party production dependencies. Only `src/publicLink`, the public bootstrap/build tool and standalone metadata are included; private Central, channel adapters, internal MCP code, recovery artifacts and private history are excluded. CI publishing is a separate operator action.

## License

Copyright 2026 hkdijia. Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Node.js, Codex CLI, Git and development tools are separately installed, retain their own licenses and are not bundled.
Source: [hkdijia/cekai-link](https://github.com/hkdijia/cekai-link).
