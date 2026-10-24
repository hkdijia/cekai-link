#!/usr/bin/env node
// Standalone source package entry: no internal artifact or Central manifest loader.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Cekai Link requires Node.js 20 or newer');
  const installedRoot = path.resolve(__dirname, '..');
  let root = installedRoot;
  // This is a content self-check, not authenticity proof. Trust the distribution source.
  const identity = await import(pathToFileURL(path.join(installedRoot, 'dist/publicLink/packageIdentity.js')).href);
  identity.verifyPublicSourcePackage(installedRoot);
  const args = process.argv.slice(2);
  // Offline help stays independent of user state; recovery always remains
  // reachable through the original npm entry, even if a selection is damaged.
  if (args[0] !== 'update' && args.length && !['help', '--help', '-h'].includes(args[0])) {
    const config = await import(pathToFileURL(path.join(installedRoot, 'dist/publicLink/config.js')).href);
    const update = await import(pathToFileURL(path.join(installedRoot, 'dist/publicLink/updateState.js')).href);
    const configPath = args[0] === 'service' && args[1] === 'host' && args[2] === '--config' && args[3]
      ? path.resolve(args[3]) : config.defaultPublicLinkConfigPath();
    root = await update.selectedUpdateRoot(configPath) || installedRoot;
    identity.verifyPublicSourcePackage(root, { allowPreviousInventory: true });
  }
  process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT = root;
  delete process.env.CEKAI_LINK_ARTIFACT_ROOT;
  const { main } = await import(pathToFileURL(path.join(root, 'dist/publicLink/cli.js')).href);
  await main(process.argv.slice(2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'cekai-link failed'); process.exitCode = 1; });
