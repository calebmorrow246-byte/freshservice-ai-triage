import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Tests mock $db to reject, which would otherwise make every retry sleep for real
    // and push the suite from milliseconds into minutes.
    env: { LF_DB_RETRY_MS: '0' },
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js'],
      reportsDirectory: 'coverage/unit',
      reporter: ['json', 'text']
    }
  }
});
