# apps/pepper/web — Pepper's SPA

Loaded when working under `apps/pepper/web/`. Root `CLAUDE.md` has commands and layout.

- React 19, react-router 7, Tailwind 4 (via `@tailwindcss/vite`), Radix primitives.
  Imports use the `@/` alias for `src/`.
- What both products share is `packages/ui` (imported as `@pepper/ui/...`): the
  app shell, UI primitives (`components/ui.tsx`, shadcn recipes and tokens, hand
  written), sign-in, status, backend settings panels, Jobs and Logs. Reuse them;
  don't add a component library or run the shadcn generator.
- Data: `@pepper/ui/lib/api` — `api.*` for requests, `useResource` for polled data,
  `useEventStream` for live server-driven updates (jobs, downloads, logs),
  `waitForJob` for one job. Don't add a fetching library.
- Colours come from CSS variables in `packages/ui/src/theme.css` (light + `.dark`); use the
  tokens, not raw hex.
- `pages/Image.tsx`, `Generate.tsx`, `Characters.tsx` are 1,000+ lines: grep for
  the component or handler and read a range.
- `npm run build` writes to `../server/public` (served by the API); no web tests
  exist, so verify with `npm run typecheck` and the preview (`.claude/launch.json`
  entry `web`, which proxies to an API on :3004).
