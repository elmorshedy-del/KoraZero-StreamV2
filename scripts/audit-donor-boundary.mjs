import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const src = join(root, 'src');
const forbidden = [
  'mpegts',
  'watch-loader',
  'watch-lab-continuity-guard',
  'iptv-lab.js',
  'stream-plan-api',
  '/api/xtream/media',
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const violations = [];
for (const path of walk(src).filter((file) => /\.(html|js|css|json)$/i.test(file))) {
  const content = readFileSync(path, 'utf8').toLowerCase();
  for (const token of forbidden) {
    if (content.includes(token.toLowerCase())) {
      violations.push(`${relative(root, path)} contains forbidden legacy token: ${token}`);
    }
  }
}

if (violations.length) {
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('donor-boundary audit passed');
