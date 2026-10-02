#!/usr/bin/env node
// Standalone source package entry: no internal artifact or Central manifest loader.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Cekai Link requires Node.js 20 or newer');
  const root = path.resolve(__dirname, '..');
  // This is a content self-check, not authenticity proof. Trust the distribution source.
  const identity = await import(pathToFileURL(path.join(root, 'dist/publicLink/packageIdentity.js')).href);
  identity.verifyPublicSourcePackage(root);
  process.env.CEKAI_LINK_SOURCE_PACKAGE_ROOT = root;
  delete process.env.CEKAI_LINK_ARTIFACT_ROOT;
  const { main } = await import(pathToFileURL(path.join(root, 'dist/publicLink/cli.js')).href);
  await main(process.argv.slice(2));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'cekai-link failed'); process.exitCode = 1; });
