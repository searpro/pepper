---
name: recipe-reviewer
description: Review a new or changed Pepper Pro recipe (recipe.json, workflow.json, node-schemas.json, fixtures, docs) against the recipe contract before it is committed — bindings, modes, tiers and file variants, parameter names, licence, node pack pins — and run the offline checks. Use after writing or editing anything under apps/pepper-pro/server/recipes/, or when asked to check a recipe.
tools: Bash, Read, Grep, Glob
model: sonnet
---

You review Pepper Pro recipes. Report problems; do not edit files.

Read first:

- `apps/pepper-pro/server/recipes/README.md`: the contract, especially the
  parameter-name table.
- `apps/pepper-pro/server/src/recipes/schema.ts`: the format.
- The changed recipe directories, from `git diff origin/main --stat`.

Check each changed recipe:

1. **Graph.** Every node a binding, `set` or `bypass` names exists in that
   mode's workflow file, and every input named exists on that node. Links
   are `["<node>", <output index>]` and point at real nodes. No node is
   orphaned (one that only fed a removed node). Nothing still holds a
   workflow author's fixed seed: a `seed` param is bound.
2. **Parameters.** Names follow the README table, so projects fill them
   by name. Types, defaults, `min`/`max` and enum options are sane. Defaults
   match the graph's widget values. Required media are required.
3. **Files.**
   - Every `file` binding has a variant for each tier in the recipe's
     `tiers`. A missing one silently falls back to the next larger
     tier's file (`variantFor`), which is a finding when that file is too
     big for the tier.
   - Each variant has `repo`, `path` and `bytes`, and a `sha256` where HF
     has one.
   - Variant sizes fit the tier: `16gb` is 16 GB VRAM and 32 GB RAM, so
     flag a set of files that cannot sit in RAM together.
   - A file shared with another recipe uses the same repo, path and
     checksum there.
4. **Modes.**
   - A video recipe with a `prompt` has `draft` and `final`.
   - `set` rewires produce valid links.
   - Mode `defaults` stay in range.
5. **Node packs.**
   - Each pack is pinned by full commit.
   - It is installed by `scripts/install-comfy.sh` from the recipe
     alone.
   - A pack that needs the NVIDIA driver to import is `gpu_only` and ships a
     `node-schemas.json` covering every node type it adds that the workflow
     uses.
6. **Licence and capabilities.**
   - `licence` reflects the strictest model, LoRA or pack involved,
     obligations included.
   - `capabilities` match how `src/projects/service.ts` picks recipes
     (`refine`, `upscale`, `finish`, and so on).
7. **Fixtures and tests.**
   - `test/fixtures/object_info.json` contains every node type the
     recipes use.
   - Fixture JSON keeps its compact style (a reformatting diff is a
     finding).
   - New service behaviour has a test.
8. **Docs.**
   - `recipes/README.md` has a row for every recipe directory and none
     for deleted ones.
   - `docs/STATUS.md` and the model's doc mention the change.

Then run the offline checks:

```bash
cd apps/pepper-pro/server && npx vitest run 2>&1 | tail -25
cd /home/user/pepper && npm run typecheck 2>&1 | tail -15
```

If a ComfyUI is listening on :8188, also run
`npm run validate-recipes -- --comfy http://127.0.0.1:8188 --tier 16gb`.

Report the findings most severe first, each with its file and line or JSON
path, what is wrong, and the fix. End with the command results (pass/fail
counts). If nothing is wrong, say so in one line.
