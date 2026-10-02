# Cekai Link

A Node.js client for workspace-bound questions through your local Codex CLI.
Installable Node.js client source. Publication and server admission are separate operator actions.
Only the `src/publicLink` source boundary is included. Central, channel adapters, MCP integrations, workspace-write execution, private artifacts and internal build code are excluded.
The public runtime has no third-party production dependencies; the development harness uses TypeScript and Vitest.

Commands: `npm ci --ignore-scripts`, `npm test`, `npm run build`, `npm pack`.
Build identity comes from this standalone Git history. No private Central release manifest is packaged.
Before pairing/running, the deployment owner must provide an external exact-package compatibility mapping via CEKAI_LINK_COMPATIBILITY_PATH. This does not grant Central approval.

## Install and setup

After an operator announces an available registry version: `npm install --global --ignore-scripts @cekaitech/cekai-link@0.1.0`. Before publication, install the operator-verified tarball instead.
Runtime requires Node.js 20+ and a separately installed/configured Codex CLI. Source development uses the locked TypeScript/Vitest toolchain; use Node 20.19+, 22.12+ or 24+. Git is required for source build and Git-workspace identity.
Run `cekai-link setup`, explicitly bind the target conversation in Central, then run `cekai-link run` in the foreground. Stop with Ctrl-C; `cekai-link inspect --json` is the diagnostic entry.
The default config/runtime namespace is `CekaiTech/cekai-link-public`, separate from the private/official Link. There is no automatic credential/workspace migration. Never point a preview at a running official Link configuration.
For parallel fixture testing, supply distinct absolute CEKAI_LINK_PUBLIC_CONFIG_PATH and CEKAI_LINK_PUBLIC_RUNTIME_PATH files. Keep credentials, compatibility mappings and runtime/lock files outside all source repositories.
Each configuration has an exclusive runtime lock. Existing locks are not stolen: inspect the recorded PID and confirm no owning Link process remains before manually removing a stale lock. Unknown owners stay untouched.
Interactive pairing uses hidden terminal input (`setup`, or `pair --server <https-url>`). A trusted automation process may pipe a code with `pair --server <https-url> --code-stdin`; never embed a real code in shell commands/history, argv, logs or Git.

## Data and execution boundary

Central receives the device name you confirm (default: this computer hostname), workspace identity digests, OS/kind and task lifecycle metadata. Workspace paths and Git remotes are not sent by workspace registration; their hashes can still be correlated and are not an anonymity guarantee.
Question and answer contents transit through Central and the user-configured Codex/model/tool providers. Dashboard-only anonymization rules do not apply to the question/answer transport. Codex may persist its own local conversation data.
Link pins the bound working directory, read-only sandbox and approval_policy=never. It preserves the user Codex configuration/Skills/tools; this is not a universal side-effect firewall for external MCP/network tools.
Threads are separated by the existing Central conversation binding plus workspace identity. The runtime does not edit project files or add internal integration/workspace-write commands.
Build digests prove content consistency, not publisher authenticity or authorization. Exact Central approval remains necessary and is not supplied by a compatibility mapping.
## License and source

Copyright 2026 hkdijia. Licensed under Apache-2.0; see LICENSE and NOTICE.
The license covers the standalone client source (src/publicLink/*.ts), bin/cekai-link-source.cjs, tools/publicLink/buildSourcePackage.mjs and this standalone project documentation/package metadata. Central and other private components are outside this distribution.
Node.js, Codex CLI, Git and development tools are separately installed and retain their own licenses; none are bundled in the runtime package.
Source repository: https://github.com/hkdijia/cekai-link. Candidate preparation does not create it.
This public candidate is publishable metadata, not evidence of an npm release. CI defaults to dry-run; actual publishing needs operator authorization and npm ownership.
