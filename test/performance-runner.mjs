import process from 'node:process';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', '.test-build/test/system.integration.js'], {
  stdio: 'inherit',
  env: { ...process.env, RUN_PERFORMANCE_BURSTS: 'true' }
});
process.exitCode = result.status ?? 1;
