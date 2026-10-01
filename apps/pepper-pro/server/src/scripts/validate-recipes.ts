/**
 * Check every shipped recipe against a ComfyUI: each mode is built with only
 * its required inputs and with all of them, and validated against the node
 * types that ComfyUI reports. Exits non-zero on any issue.
 *
^ *   npm run validate-recipes -w @pepper-pro/server -- [--comfy http://127.0.0.1:8188] [--tier 32gb] [--dir recipes]
 *     [--write-fixture test/fixtures/object_info.json]
 *
 * Model files need not be present (file choices are not checked), but every
 * custom node pack a recipe uses must be installed: that is the point. The
 * image build runs this against a CPU ComfyUI; run it on a pod after
 * changing a recipe or bumping ComfyUI. `--write-fixture` also saves the
 * node types the recipes use, which the unit tests validate against offline;
 * refresh it whenever ComfyUI is bumped.
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { ComfyClient, type ObjectInfo } from '../comfy/client.js';
import { classTypes } from '../comfy/graph.js';
import { TIERS, type Tier } from '../config.js';
import { checkRecipe } from '../recipes/check.js';
import { RecipeStore } from '../recipes/store.js';
import type { ProPaths } from '../paths.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const comfyUrl = option('comfy') ?? 'http://127.0.0.1:8188';
const tier = (option('tier') ?? '32gb') as Tier;
if (!TIERS.includes(tier)) throw new Error(`--tier must be one of ${TIERS.join(', ')}`);
const dir = option('dir') ?? fileURLToPath(new URL('../../recipes', import.meta.url));

const log = pino({ level: 'warn' });
const store = new RecipeStore(dir, { modelsDir: '/nonexistent' } as ProPaths, log);
await store.load();
const objectInfo = await new ComfyClient(comfyUrl).objectInfo();

let failed = store.broken.length;
for (const broken of store.broken) console.log(`✗ ${broken.id}: does not load: ${broken.error}`);
for (const recipe of store.list()) {
  for (const check of checkRecipe(recipe, (name) => store.workflow(recipe, name), { tier, objectInfo })) {
    const label = `${check.recipe} ${check.mode} (${check.inputs} inputs)`;
    if (check.issues.length === 0) {
      console.log(`✓ ${label}`);
      continue;
    }
    failed++;
    console.log(`✗ ${label}`);
    for (const issue of check.issues) console.log(`    ${issue}`);
  }
}
const fixture = option('write-fixture');
if (fixture) {
  const used = new Set(store.list().flatMap((recipe) => Object.keys(recipe.workflows).flatMap((name) => classTypes(store.workflow(recipe, name)))));
  const subset: ObjectInfo = {};
  for (const type of [...used].sort()) if (objectInfo[type]) subset[type] = objectInfo[type];
  await writeFile(fixture, `${JSON.stringify(subset)}\n`);
  console.log(`wrote ${Object.keys(subset).length} node types to ${fixture}`);
}
console.log(failed === 0 ? `\n${store.list().length} recipes valid` : `\n${failed} problem(s)`);
process.exit(failed === 0 ? 0 : 1);
