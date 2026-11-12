// Downloads oemer's ONNX models (MIT, https://github.com/BreezeWhite/oemer) into public/models/.
// They are ~110 MB, so they are not stored in git; CI runs this before building.
// Run: npm run fetch-models
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'public', 'models');
const BASE = 'https://github.com/BreezeWhite/oemer/releases/download/checkpoints/';

export const MODELS = [
  { file: '1st_model.onnx', sha256: '37512e858731096439746f60b377c049f07055b4a23ec6eb9a178ce92cfba174', bytes: 70767752 },
  { file: '2nd_model.onnx', sha256: 'ed2e1a86ea75712ee6cdc740e96f7a36753543cf9bb980227c071c9256d9d82e', bytes: 38448467 },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

mkdirSync(dir, { recursive: true });
for (const m of MODELS) {
  const path = join(dir, m.file);
  if (existsSync(path) && sha(readFileSync(path)) === m.sha256) {
    console.log(`✓ ${m.file} already present`);
    continue;
  }
  process.stdout.write(`↓ ${m.file} (${(m.bytes / 1e6).toFixed(1)} MB)… `);
  const res = await fetch(BASE + m.file, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${m.file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha(buf);
  if (got !== m.sha256) throw new Error(`${m.file}: checksum mismatch (got ${got})`);
  writeFileSync(path + '.part', buf);
  renameSync(path + '.part', path);
  console.log('ok');
}
writeFileSync(join(dir, 'models.json'), JSON.stringify({ source: BASE, license: 'MIT (oemer)', models: MODELS }, null, 2));
