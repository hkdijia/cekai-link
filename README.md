# Cekai Link

A small Node.js client for workspace-bound questions through your local Codex CLI.
The standalone client is open source under Apache-2.0. Central is a separate service.

## Install and first use

This source defines `@cekaitech/cekai-link@0.1.1`. Check with your deployment owner that the registry version is available and approved before installing it:

```sh
npm install --global --ignore-scripts @cekaitech/cekai-link@0.1.1
```

Before registry publication, use the deployment owner's reviewed `cekaitech-cekai-link-0.1.1.tgz` instead of the registry name. Check its SHA256 against the owner's delivery record, then install that same file with `npm install --global --ignore-scripts /absolute/path/to/cekaitech-cekai-link-0.1.1.tgz`. Installing a package does not grant Central admission.

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
