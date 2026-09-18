import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
function read(path) { return readFileSync(join(root, path), 'utf8'); }

test('watch and lab both import the same player controller', () => { const watch=read('src/player/watch-entry.js'); const lab=read('src/player/lab-entry.js'); assert.match(watch,/player-controller/); assert.match(lab,/player-controller/); });
test('entrypoints contain no independent retry or media-engine implementation', () => { for (const path of ['src/player/watch-entry.js','src/player/lab-entry.js']) { const source=read(path); assert.doesNotMatch(source,/setTimeout\s*\(/); assert.doesNotMatch(source,/new\s+Hls\s*\(/); assert.doesNotMatch(source,/loadSource\s*\(/); assert.doesNotMatch(source,/recoverMediaError/); } });
test('watch and lab resolve logical channels through the shared playback descriptor loader', () => { const watch=read('src/player/watch-entry.js'); const lab=read('src/player/lab-entry.js'); assert.match(watch,/playback-descriptor/); assert.match(lab,/playback-descriptor/); assert.doesNotMatch(watch,/params\.get\(['"]manifest/); assert.doesNotMatch(lab,/manifest-input/); });
test('Lab UI accepts a logical channel id, not an arbitrary manifest URL', () => { const lab=read('src/lab.html'); assert.match(lab,/id="channel-input"/); assert.doesNotMatch(lab,/manifest-input/); assert.doesNotMatch(lab,/type="url"/); });
