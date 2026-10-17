import { exec } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from 'vitest';

const execAsync = promisify(exec);

test('include the exported files in the published package', async () => {
  // Bundlers still resolve the `ecij` import left in place by the plugin, so `index.js` must ship
  const { stdout } = await execAsync('npm pack --dry-run --json');
  // npm 12 keys the packages by name, earlier versions list them in an array
  const [{ files }] = Object.values(JSON.parse(stdout) as object) as [
    { files: Array<{ path: string }> },
  ];

  expect(files.map((file) => file.path)).toMatchInlineSnapshot(`
    [
      "LICENSE",
      "README.md",
      "dist/index.d.ts",
      "dist/index.js",
      "index.d.ts",
      "index.js",
      "package.json",
    ]
  `);
});
