#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = process.argv[2];
const verArg = process.argv[3];

function usage() {
  console.error('Usage: set-version.mjs <version>   |   set-version.mjs --check <version>');
  process.exit(1);
}

const mode = arg === '--check' ? 'check' : arg === undefined ? usage() : 'set';
const VER = mode === 'check' ? verArg : arg;
if (!VER) usage();
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(VER)) {
  console.error(`Invalid version: ${VER}`);
  process.exit(1);
}

const PKG = path.join(root, 'package.json');
const PLG = path.join(root, '.claude-plugin', 'plugin.json');
const MKT = path.join(root, '.claude-plugin', 'marketplace.json');

// metadata.version in marketplace.json is a separate field (marketplace schema
// version) and is intentionally NOT tracked. Only plugins[0].version is.
const files = {
  'package.json': () => JSON.parse(fs.readFileSync(PKG, 'utf8')).version,
  '.claude-plugin/plugin.json': () => JSON.parse(fs.readFileSync(PLG, 'utf8')).version,
  '.claude-plugin/marketplace.json[plugins[0].version]':
    () => JSON.parse(fs.readFileSync(MKT, 'utf8')).plugins[0].version,
};

if (mode === 'check') {
  const bad = Object.entries(files).filter(([, get]) => get() !== VER);
  if (bad.length) {
    console.error(`Version mismatch (expected ${VER}):`);
    for (const [f, get] of bad) console.error(`  ${f}: ${get()}`);
    process.exit(1);
  }
  console.log(`All Claude version files == ${VER}`);
  process.exit(0);
}

// set
for (const file of [PKG, PLG]) {
  const cur = fs.readFileSync(file, 'utf8');
  const re = /"version":\s*"[^"]+"/u;
  if (!re.test(cur)) { console.error(`version not found in ${file}`); process.exit(1); }
  fs.writeFileSync(file, cur.replace(re, `"version": "${VER}"`), 'utf8');
}
const mkt = JSON.parse(fs.readFileSync(MKT, 'utf8'));
mkt.plugins[0].version = VER;
fs.writeFileSync(MKT, `${JSON.stringify(mkt, null, 2)}\n`, 'utf8');
for (const [f, get] of Object.entries(files)) console.log(`${f} -> ${get()}`);
