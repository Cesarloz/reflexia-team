import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile(new URL('../asset-manifest.json', import.meta.url), 'utf8'));
for (const item of manifest) {
  const bytes = await readFile(new URL('../public/assets/' + item.name, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, `La imagen original cambió: ${item.name}`);
  assert.equal(bytes.length, item.bytes);
}
console.log('9 imágenes originales verificadas: contenido idéntico, sin recorte ni edición.');
