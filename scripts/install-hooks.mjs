import process, { stdout } from 'node:process';

// Installs the git hooks (.husky): run `pnpm hooks:install` once after cloning. Not a `prepare` script, because
// a non-empty prepare makes `pnpm add -g github:ideaSquared/shipper` fail (ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED).
try {
  const { default: husky } = await import('husky');
  const message = husky();
  if (message) stdout.write(`${message}\n`);
} catch {
  stdout.write('husky is not installed: run pnpm install first.\n');
  process.exitCode = 1;
}
