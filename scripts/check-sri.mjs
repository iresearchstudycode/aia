#!/usr/bin/env node
/**
 * SRI guard: re-hash every `integrity=`-pinned vendored asset referenced from
 * src/aia/index.html and fail if the computed `sha256-<base64>` does not match
 * the `integrity=` attribute.
 *
 * This is the guard against the line-ending class of bug: all pinned assets are
 * `binary` in .gitattributes, so the committed bytes are what the bind mount
 * serves and what the browser verifies. If a hash is ever recomputed from a
 * CRLF working copy (or a file is re-vendored without updating index.html) this
 * check fails on the clean CI checkout before it can reach a browser.
 *
 * No dependencies — Node builtins only.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = join(repoRoot, 'src', 'aia', 'index.html');
const indexHtml = readFileSync(indexPath, 'utf8');

// Match <script ... src="..." ... integrity="sha256-..."> and
// <link ... href="..." ... integrity="sha256-..."> in either attribute order.
const tagRe = /<(script|link)\b[^>]*?>/gi;
const attrRe = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]+)"`, 'i');

const targets = [];
for (const [tag] of indexHtml.matchAll(tagRe)) {
  const integrity = tag.match(attrRe('integrity'));
  if (!integrity) continue;
  const ref = tag.match(attrRe(tag.toLowerCase().startsWith('<link') ? 'href' : 'src'));
  if (!ref) {
    console.error(`SRI check: <${tag}> has integrity= but no src/href`);
    process.exitCode = 1;
    continue;
  }
  targets.push({ ref: ref[1].replace(/^\.?\//, ''), integrity: integrity[1].trim() });
}

if (targets.length === 0) {
  console.error(`SRI check: no integrity= tags found in ${indexPath} — regex broken?`);
  process.exit(1);
}

let failed = 0;
for (const { ref, integrity } of targets) {
  const filePath = join(repoRoot, 'src', 'aia', ref);
  const bytes = readFileSync(filePath);
  const digest = 'sha256-' + createHash('sha256').update(bytes).digest('base64');
  const cr = bytes.includes(0x0d);
  if (digest !== integrity) {
    failed += 1;
    console.error(`MISMATCH  ${ref}`);
    console.error(`  index.html: ${integrity}`);
    console.error(`  computed:   ${digest}${cr ? '  (file contains CR bytes)' : ''}`);
  } else {
    console.log(`ok  ${ref}  ${digest}`);
  }
}

if (failed > 0) {
  console.error(`\nSRI check failed: ${failed} of ${targets.length} pinned asset(s) do not match index.html.`);
  process.exit(1);
}
console.log(`\nSRI check passed: ${targets.length} pinned asset(s) match index.html.`);
