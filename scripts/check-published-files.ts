// Checks that `npm pack` includes every file referenced by `exports`, as `files` lists them separately
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const { exports } = JSON.parse(readFileSync('package.json', 'utf8')) as {
  exports: Record<string, Record<string, string>>;
};

// npm 12 keys the packages by name, earlier versions list them in an array
const [{ files }] = Object.values(
  JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8' })) as object,
) as [{ files: Array<{ path: string }> }];

const publishedPaths = new Set(files.map((file) => file.path));
const missingPaths = Object.values(exports)
  .flatMap((conditions) => Object.values(conditions))
  .map((path) => path.replace(/^\.\//, ''))
  .filter((path) => !publishedPaths.has(path));

if (missingPaths.length > 0) {
  console.error(`Exported files missing from the package: ${missingPaths.join(', ')}`);
  process.exitCode = 1;
}
