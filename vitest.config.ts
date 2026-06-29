import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/packages/e2e/**',
      '**/connexis-demo/**',
      '**/.{idea,git,cache,output,temp}**'
    ]
  }
});
