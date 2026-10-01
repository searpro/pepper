#!/usr/bin/env node
/**
 * Convert a ComfyUI UI-format workflow (what the editor saves, and what the
 * official templates ship as) into the API-format prompt Pepper Pro submits.
 *
 * The conversion is done by ComfyUI's own frontend, in a headless browser,
 * rather than reimplemented: templates use subgraphs, links converted from
 * widgets, and seed widgets with a hidden "control after generate" value, and
 * `app.graphToPrompt()` is the one implementation that gets all of that right
 * for the frontend version the pinned ComfyUI ships.
 *
 *   node convert-template.mjs <workflow.json> [--comfy http://127.0.0.1:8188] > api.json
 *
 * Needs a running ComfyUI (CPU is fine: nothing is executed) with every
 * custom node the workflow uses, and Playwright with a Chromium.
 */
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const comfyIndex = args.indexOf('--comfy');
const comfy = comfyIndex >= 0 ? args[comfyIndex + 1] : 'http://127.0.0.1:8188';
if (!file) {
  console.error('usage: convert-template.mjs <workflow.json> [--comfy URL]');
  process.exit(2);
}

const workflow = JSON.parse(await readFile(file, 'utf8'));
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
});
try {
  const page = await browser.newPage();
  await page.goto(comfy, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.app?.graph), null, { timeout: 60_000 });
  const result = await page.evaluate(async (graph) => {
    await window.app.loadGraphData(graph, true, true, null, { showMissingNodesDialog: false, showMissingModelsDialog: false });
    const missing = graph.nodes
      ?.filter((n) => n.type && !window.LiteGraph.registered_node_types[n.type] && !graph.definitions?.subgraphs?.some((s) => s.id === n.type))
      .map((n) => n.type);
    const prompt = await window.app.graphToPrompt();
    return { output: prompt.output, missing: [...new Set(missing ?? [])] };
  }, workflow);
  if (result.missing.length) {
    console.error(`missing node types: ${result.missing.join(', ')}`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(result.output, null, 2) + '\n');
} finally {
  await browser.close();
}
