import { spawn, execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { withPostgres } from './with-postgres.mjs';
import { postgresTestEnvironment } from './postgres-test-environment.mjs';

const values = new Map();
let reportReady = false;
try {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    if (!['--data-dir', '--report-dir'].includes(args[i]) || !args[i + 1] || values.has(args[i])) throw new Error('Expected --data-dir and --report-dir');
    values.set(args[i], resolve(args[i + 1]));
  }
  if (values.size !== 2) throw new Error('Explicit --data-dir and --report-dir are required; this command never downloads data');
  const withinPackage = relative(fileURLToPath(new URL('../', import.meta.url)), values.get('--report-dir'));
  if (withinPackage === '' || (!(withinPackage === '..' || withinPackage.startsWith(`..${sep}`)) && !isAbsolute(withinPackage)) || values.get('--data-dir') === values.get('--report-dir'))
    throw new Error('Report directory must be outside the package and separate from source');
  await mkdir(values.get('--report-dir'), { recursive: true });
  reportReady = true;
  await writeFile(resolve(values.get('--report-dir'), 'full-verification.json'), JSON.stringify({passed:false,verified:false,phase:'starting'}));
  if (!(await stat(values.get('--data-dir'))).isDirectory()) throw new Error('Source directory must exist');
  // The real CLI runs built files; never verify a stale dist against current source queries.
  const build = await promisify(execFile)('npm', ['run', 'build'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
  });
  process.stdout.write(build.stdout);
  process.exitCode = await withPostgres(async connection => {
    const { stdout } = await promisify(execFile)('docker', ['inspect', connection.containerId, '--format',
      '{"image":{{json .Config.Image}},"memoryLimitBytes":{{json .HostConfig.Memory}},"nanoCpuLimit":{{json .HostConfig.NanoCpus}},"tmpfs":{{json .HostConfig.Tmpfs}}}']);
    await writeFile(resolve(values.get('--report-dir'), 'container-environment.json'), stdout);
    return new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/full-check.ts',
      '--data-dir', values.get('--data-dir'), '--report-dir', values.get('--report-dir')], {
      cwd: fileURLToPath(new URL('../', import.meta.url)),
      env: postgresTestEnvironment(connection), stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => resolveExit(code ?? 1));
    });
  });
} catch (error) {
  const message = error instanceof Error ? error.message : 'Full verification environment failed';
  if (reportReady) await writeFile(resolve(values.get('--report-dir'), 'environment-failure.json'),
    JSON.stringify({ passed: false, verified: false, phase: 'environment', message }, null, 2)).catch(() => {});
  console.error(message);
  process.exitCode = 1;
}
