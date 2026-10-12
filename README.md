# Cekai Link

A small Node.js client for workspace-bound questions through your local Codex CLI.
The standalone client is open source under Apache-2.0. Central is a separate service.

[中文接入指引](#中文接入指引) · [English](#install-and-first-use)

## 中文接入指引

`@cekaitech/cekai-link@0.1.1` 已公开发行。无需 clone 仓库，Mac、Windows、Linux 使用同一个 Node.js 包。已正常运行 0.1.1 的用户继续使用即可，不需要重新安装或配对。

### 1. 安装前准备

确认本机 Node.js 20+、Git 和单独安装的 Codex CLI 可用：

```sh
node --version
git --version
codex --version
```

还需使用自己的账号完成一次原生 Codex 问答。找到可执行文件不代表模型账号或额度可用；Link 不代装、登录或修改个人 Codex 配置。

向可信部署方取得 Central HTTPS 地址、自己的设备配对码，以及与当前安装包和 Central 版本精确匹配的兼容文件。将兼容文件保存在本机固定位置、项目仓库和安装包之外。部署方还需确认当前包已获 Central 准入；npm 安装和兼容文件本身不授予准入。

选择本机已有的工作目录。设备配对、工作区登记、聊天会话绑定是三个步骤；安装 Link 不会自动绑定目录或切换会话。

### 2. 安装并设置

Mac / Linux 使用当前用户可写的 npm global prefix，不为 Link 修改系统目录权限：

```sh
npm install --global --ignore-scripts @cekaitech/cekai-link@0.1.1
cekai-link setup
```

Windows 在普通用户 PowerShell 使用 `.cmd`，无需修改全局执行策略：

```powershell
npm.cmd install --global --ignore-scripts @cekaitech/cekai-link@0.1.1
cekai-link.cmd setup
```

setup 先验证兼容文件的绝对路径，再检查 Codex，然后询问 Central 地址和配对码。配对码使用隐藏输入，不放入命令行、截图或日志。确认设备名称、自己选择的工作目录和登记操作；配对成功后会保存兼容文件路径，新终端无需重复设置环境变量。

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
| `configure-compatibility` | 向部署方取得当前包对应文件，重跑 setup 保存路径 |
| `install-codex` / `diagnose-codex` | 先确认原生 Codex 可独立启动和问答，不猜账号或额度原因 |
| `bind-conversation` | 在自己的目标会话显式绑定本机设备和工作区 |
| `start-link` | 确认原进程已退出且无待恢复任务，再前台 run |
| `diagnose-central` / `retry-central-inspection` | 保留配对，核对网络和部署方准入，重新 inspect |
| `resolve-recovery` 或原进程持锁 | 先核对进程归属与执行、投递终态，不删锁或盲目重复任务 |

显式 `CEKAI_LINK_COMPATIBILITY_PATH` 优先于已保存路径，错误覆盖不会自动回退。升级需与部署方协调；回退 0.1.0 必须恢复升级前配置、原包、匹配兼容文件及 Central 准入，不能只降 npm 版本。旧 0.1.0 不能读取含新增 `compatibilityPath` 字段的新配置；不要恢复陈旧 runtime 或心跳序号。详见 [升级与回退](#011-changes-and-upgrade)。

反馈实际失败时，只提供发生时间（含时区）、安装版本、可见错误类别、是否收到最终回执，以及 inspect 的状态和下一步。不发送配对码、配置文件、凭据、工作目录、问题或回答正文、原始日志。

### 5. 数据与执行边界

Link 固定绑定工作目录、`sandbox=read-only` 和 `approval_policy=never`，继承个人 Codex 的 Skills、MCP、model/provider 配置，不干预答案。Codex 对外部工具的规则继续生效；文件只读沙箱不保证外部 MCP 或网络工具没有副作用。

问题和回答会经过 Central 及用户配置的 Codex、模型或工具提供方；大屏脱敏不等于问答内容不传输。Central 接收确认后的设备名称（默认主机名）、工作区身份摘要、平台和任务生命周期事实，登记不上传工作目录或 Git remote；摘要仍可关联。Codex 可能保留本机会话数据。inspect 与大屏省略正文、路径、凭据和原始错误。

## Install and first use

`@cekaitech/cekai-link@0.1.1` is published. Confirm that your deployment owner has approved the exact package for their Central before installing it:

```sh
npm install --global --ignore-scripts @cekaitech/cekai-link@0.1.1
```

For owner-arranged offline delivery, use the owner's reviewed `cekaitech-cekai-link-0.1.1.tgz` and check its SHA256 against the delivery record before installing that same file with `npm install --global --ignore-scripts /absolute/path/to/cekaitech-cekai-link-0.1.1.tgz`. Installing a package does not grant Central admission.

Use `npm.cmd` and `cekai-link.cmd` in Windows PowerShell. You do not need to change your global execution policy.

Before setup you need:

1. Node.js 20+ and a separately installed, working Codex CLI with your own account/configuration. Link does not install or log in to Codex. Git is needed for Git workspace identity.
2. A trusted deployment owner's HTTPS Central address, pairing code and compatibility file matching the **exact installed package**. Keep this file outside the package and source repositories. The file is not Central admission approval.
3. A local workspace you choose, and an explicit binding in your target robot conversation. Workspace registration does not switch another user's conversation.

Run `cekai-link setup`, then `cekai-link run` in the foreground. Follow the next action from `cekai-link inspect`; explicitly bind the target conversation before asking questions. Natural-language questions do not require `/agent`. Keep the foreground terminal open; Ctrl+C stops only this Link. There is no automatic service or update.

**0.1.1:** setup asks for the compatibility-file path first, validates it before collecting a pairing code, and saves the path in the existing local config after pairing. Subsequent terminals use that path without an environment variable:

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

Build digests prove content consistency, not publisher authenticity or authorization. An owner-issued mapping and Central's exact approval are both required. Threads remain scoped by conversation binding and workspace identity.

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
