# apps/pepper-pro/web — Pepper Pro's SPA

Loaded when working under `apps/pepper-pro/web/`. Root `CLAUDE.md` has commands and layout.

- Same stack and rules as Pepper's SPA (`apps/pepper/web/CLAUDE.md`): the shell,
  primitives, Jobs, Logs and backend settings come from `@pepper/ui`; data goes
  through `@pepper/ui/lib/api` (`api.*`, `useResource`, `waitForJob`).
- Pro's API types are in `src/lib/pro.ts`; rows keep the server's camelCase.
- Screens: `pages/Projects.tsx`, `pages/Project.tsx` (storyboard, cast, cut,
  settings; the shot editor and takes are `components/ShotDialog.tsx`),
  `Generate.tsx` (a form built from a recipe's parameters by
  `components/inputs.tsx`), `Recipes.tsx` (with `components/Golden.tsx`), `Media.tsx`.
- A recipe whose licence has a `ui_notice` (MiniMax H3) must show it where its
  output is shown: use `LicenceNotice`.
- `npm run build` writes to `../server/public`. Develop with
  `PEPPER_API=http://localhost:<port> npm run dev:pro-web` against a running
  Pro server; there are no web tests, so verify with typecheck and the browser.
