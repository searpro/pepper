#!/usr/bin/env node
/**
 * Summarise a ComfyUI UI-format workflow (a Civitai download, a template, a
 * canvas save) before it becomes a recipe: what is switched on, which node
 * packs it needs, the model files, LoRAs and sampler settings, the prompts
 * and the author's notes. Large community workflows are mostly canvas wiring
 * (Set/Get, switches, bypassers) and half their nodes are bypassed, so
 * reading the JSON by eye misses the settings that make the samples look the
 * way they do.
 *
 *   node scripts/inspect-workflow.mjs <workflow.json> [--object-info URL|file] [--all] [--json]
 *
 * `--object-info` (a running ComfyUI, or a saved full /object_info) names each
 * widget value and marks node types the pinned ComfyUI does not have; without
 * it, packs come from the workflow's own `cnr_id` properties and widgets are
 * listed by position. Bypassed (mode 4) and muted (mode 2) nodes are left out
 * of the settings unless `--all`; the group list still says what each holds.
 */
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = args.find((arg, i) => !arg.startsWith('--') && !['--object-info'].includes(args[i - 1]));
if (!file) {
  console.error('usage: inspect-workflow.mjs <workflow.json> [--object-info URL|file] [--all] [--json]');
  process.exit(2);
}
const showAll = args.includes('--all');

const workflow = JSON.parse(await readFile(file, 'utf8'));
if (!Array.isArray(workflow.nodes)) {
  console.error('not a UI-format workflow (no "nodes" array); an API-format prompt is already what a recipe holds');
  process.exit(1);
}

let objectInfo;
const source = option('object-info');
if (source) {
  objectInfo = /^https?:/.test(source)
    ? await (await fetch(`${source.replace(/\/$/, '')}/object_info`)).json()
    : JSON.parse(await readFile(source, 'utf8'));
}

const MODES = { 0: 'on', 2: 'muted', 4: 'bypassed' };
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt|pth|bin|onnx|sft)$/i;
// Canvas plumbing that recipes replace with bindings, modes and bypass.
const PLUMBING = /^(SetNode|GetNode|Reroute|PrimitiveNode|Note|MarkdownNote|Label \(rgthree\)|Fast (Groups )?(Bypasser|Muter) \(rgthree\)|Any Switch \(rgthree\)|Context.*\(rgthree\)|ImpactExecutionOrderController|Display Any.*|PreviewAny|PreviewImage)$/;

const subgraphs = new Map((workflow.definitions?.subgraphs ?? []).map((graph) => [graph.id, graph]));

// Every node, with subgraph contents flattened under their instance's path.
const nodes = [];
const walk = (list, path, inheritedMode) => {
  for (const node of list ?? []) {
    const mode = inheritedMode === 0 ? (node.mode ?? 0) : inheritedMode;
    const id = path ? `${path}:${node.id}` : String(node.id);
    const graph = subgraphs.get(node.type);
    if (graph) {
      nodes.push({ ...node, id, mode, subgraph: graph.name ?? node.type });
      walk(graph.nodes, id, mode);
    } else {
      nodes.push({ ...node, id, mode });
    }
  }
};
walk(workflow.nodes, '', 0);

const groupOf = (node) => {
  if (node.id.includes(':') || !node.pos) return undefined;
  const [x, y] = Array.isArray(node.pos) ? node.pos : [node.pos[0], node.pos[1]];
  const hit = (workflow.groups ?? []).filter(({ bounding: [gx, gy, gw, gh] }) => x >= gx && y >= gy && x <= gx + gw && y <= gy + gh);
  // The innermost group is the one with the smallest area.
  hit.sort((a, b) => a.bounding[2] * a.bounding[3] - b.bounding[2] * b.bounding[3]);
  return hit[0]?.title;
};

const packOf = (node) => {
  if (node.subgraph) return 'subgraph';
  const props = node.properties ?? {};
  const declared = props.cnr_id ?? props.aux_id;
  if (objectInfo) {
    const info = objectInfo[node.type];
    if (!info) return `NOT IN OBJECT_INFO${declared && declared !== 'comfy-core' ? ` (${declared})` : ''}`;
    return info.python_module?.startsWith('custom_nodes') ? info.python_module.replace(/^custom_nodes\./, '') : 'core';
  }
  return declared === 'comfy-core' ? 'core' : (declared ?? '?');
};

const widgetNames = (node) => {
  const info = objectInfo?.[node.type];
  if (!info) return undefined;
  const names = [];
  for (const section of ['required', 'optional']) {
    for (const [name, spec] of Object.entries(info.input?.[section] ?? {})) {
      const [type, options] = Array.isArray(spec) ? spec : [spec];
      const isWidget = Array.isArray(type) || ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'].includes(type) || (typeof type === 'string' && type.startsWith('COMFY_') && options?.options);
      if (!isWidget) continue;
      names.push(name);
      if (options?.control_after_generate) names.push(`${name}.control`);
    }
  }
  return names;
};

const widgets = (node) => {
  const values = node.widgets_values;
  if (values == null) return {};
  if (!Array.isArray(values)) return values;
  const names = widgetNames(node);
  return Object.fromEntries(values.map((value, i) => [names?.[i] ?? `#${i}`, value]));
};

const short = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
};

const active = nodes.filter((node) => node.mode === 0);
const report = {
  file,
  nodes: nodes.length,
  modes: Object.fromEntries(Object.entries(Object.groupBy(nodes, (node) => MODES[node.mode] ?? `mode ${node.mode}`)).map(([k, v]) => [k, v.length])),
  packs: {},
  groups: [],
  files: [],
  loras: [],
  sampling: [],
  prompts: [],
  notes: [],
  setGet: {},
  settings: [],
};

for (const node of nodes) {
  const pack = packOf(node);
  const entry = (report.packs[pack] ??= { versions: new Set(), types: new Set(), active: 0 });
  if (node.properties?.ver) entry.versions.add(node.properties.ver);
  entry.types.add(node.type);
  if (node.mode === 0) entry.active++;
}

const byGroup = Object.groupBy(nodes.filter((node) => !node.id.includes(':')), (node) => groupOf(node) ?? '(no group)');
for (const [title, members] of Object.entries(byGroup)) {
  const on = members.filter((node) => node.mode === 0).length;
  report.groups.push({ title, on, off: members.length - on, types: [...new Set(members.filter((n) => !PLUMBING.test(n.type)).map((n) => n.type))] });
}

for (const node of showAll ? nodes : active) {
  const values = widgets(node);
  const where = `${node.id} ${node.type}${node.title && node.title !== node.type ? ` "${node.title}"` : ''}`;
  for (const value of Object.values(values)) {
    if (typeof value === 'string' && MODEL_FILE.test(value)) report.files.push({ node: where, file: value });
  }
  for (const model of node.properties?.models ?? []) report.files.push({ node: where, file: model.name, directory: model.directory, url: model.url });
  if (/lora/i.test(node.type)) report.loras.push({ node: where, ...values });
  if (/sampler|scheduler|sigma|guider|cfg|shift|noise/i.test(node.type) && !/loader/i.test(node.type)) report.sampling.push({ node: where, ...values });
  if (/text ?encode|prompt/i.test(node.type) || node.title?.match(/prompt/i)) {
    for (const value of Object.values(values)) if (typeof value === 'string' && value.length > 20) report.prompts.push({ node: where, text: value });
  }
  if (node.type === 'SetNode') report.setGet[values['#0'] ?? node.title] = node.inputs?.[0]?.link;
  if (!PLUMBING.test(node.type)) report.settings.push({ node: where, mode: MODES[node.mode], group: groupOf(node), pack: packOf(node), widgets: values });
}
// Notes are read even when muted: authors keep instructions in them. Copies
// pasted beside each loop are listed once.
const seenNotes = new Set();
for (const node of nodes) {
  if (!/note|label/i.test(node.type)) continue;
  for (const value of node.widgets_values ?? []) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || seenNotes.has(text)) continue;
    seenNotes.add(text);
    report.notes.push({ node: `${node.id} ${node.title ?? node.type}`, text });
  }
}

if (args.includes('--json')) {
  for (const entry of Object.values(report.packs)) {
    entry.versions = [...entry.versions];
    entry.types = [...entry.types];
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const out = [];
const heading = (text) => out.push('', `## ${text}`);
out.push(`# ${file}`, `${report.nodes} nodes: ${Object.entries(report.modes).map(([k, v]) => `${v} ${k}`).join(', ')}`);
heading('Node packs');
for (const [pack, { versions, types, active: count }] of Object.entries(report.packs).sort()) {
  out.push(`- ${pack}${versions.size ? ` (ver ${[...versions].join(', ')})` : ''}: ${count} on; ${[...types].sort().join(', ')}`);
}
heading('Groups (on/off)');
for (const group of report.groups) out.push(`- ${group.title}: ${group.on}/${group.off}${group.types.length ? ` — ${group.types.join(', ')}` : ''}`);
heading(`Model files${showAll ? '' : ' (active nodes)'}`);
for (const { node, file: name, directory, url } of report.files) out.push(`- ${name}${directory ? ` [${directory}]` : ''}${url ? ` <${url}>` : ''} — ${node}`);
heading('LoRAs');
for (const { node, ...values } of report.loras) out.push(`- ${node}: ${short(values)}`);
heading('Sampling');
for (const { node, ...values } of report.sampling) out.push(`- ${node}: ${short(values)}`);
heading('Prompts');
for (const { node, text } of report.prompts) out.push(`- ${node}:`, `  ${text.replace(/\n/g, '\n  ')}`);
heading('Notes');
for (const { node, text } of report.notes) out.push(`- ${node}:`, `  ${text.replace(/\n/g, '\n  ')}`);
heading(`Settings, every ${showAll ? '' : 'active '}non-plumbing node`);
for (const { node, mode, group, pack, widgets: values } of report.settings) {
  out.push(`- ${node} [${pack}${group ? `, ${group}` : ''}${mode !== 'on' ? `, ${mode}` : ''}]${Object.keys(values).length ? `: ${short(values)}` : ''}`);
}
process.stdout.write(`${out.join('\n')}\n`);
