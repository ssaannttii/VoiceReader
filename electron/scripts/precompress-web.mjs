// Write .br and .gz siblings for the web build's text assets so the backend
// (backend/core/spa_static.py) can serve them compressed. Node built-ins only.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(process.argv[2] ?? path.join(here, '..', '..', 'frontend', 'dist'));
const TEXT = /\.(?:js|mjs|css|html|json|svg|webmanifest|txt|map)$/i;
const MIN_BYTES = 1024;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let before = 0;
let after = 0;
let files = 0;
for (const file of walk(dist)) {
  if (!TEXT.test(file) || statSync(file).size < MIN_BYTES) continue;
  const data = readFileSync(file);
  const br = brotliCompressSync(data, {
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  });
  const gz = gzipSync(data, { level: 9 });
  // A variant that doesn't shrink the file is pointless to serve.
  if (br.length < data.length) writeFileSync(`${file}.br`, br);
  if (gz.length < data.length) writeFileSync(`${file}.gz`, gz);
  before += data.length;
  after += Math.min(br.length, data.length);
  files += 1;
}
console.log(
  `precompressed ${files} files: ${(before / 1024).toFixed(0)} KB -> ${(after / 1024).toFixed(0)} KB (brotli)`,
);
