import { stdout } from 'node:process';

// Installs the git hooks (.husky). husky is a devDependency, so it is missing for a production install or
// a `pnpm add -g github:ideaSquared/shipper`; then there is nothing to do and the install must not fail.
try {
  const { default: husky } = await import('husky');
  const message = husky();
  if (message) stdout.write(`${message}\n`);
} catch {
  // husky is not installed
}
