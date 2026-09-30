import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run against @pepper/core's source, as `npm run dev` does.
  resolve: { conditions: ['pepper-source'] },
  ssr: { resolve: { conditions: ['pepper-source'], externalConditions: ['pepper-source'] } },
});
