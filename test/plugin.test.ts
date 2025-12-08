import { rolldown } from 'rolldown';
import { expect, test } from 'vitest';
import { ecij, type Configuration } from '../src/index';

// Helper to run a rolldown build with the ecij plugin
async function buildWithPlugin(input: string, pluginOptions?: Configuration) {
  const build = await rolldown({
    input,
    plugins: [ecij(pluginOptions)],
  });

  const { output } = await build.generate();

  // Extract JS and CSS outputs
  const jsChunk = output.find((chunk) => chunk.type === 'chunk');
  const cssChunk = output.find((chunk) => chunk.type === 'asset');

  return {
    js: jsChunk?.code,
    css: cssChunk?.source,
  };
}

test('comprehensive CSS-in-JS patterns', async () => {
  const fixturePath = import.meta.resolve('./fixtures/comprehensive.input.ts');
  const result = await buildWithPlugin(fixturePath);

  // Comprehensive fixture includes:
  // - Basic CSS extraction
  // - Multiple declarations
  // - Local variable interpolation
  // - Imported class name interpolation
  // - Nested interpolations
  // - Inline CSS (not assigned to variable)
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/comprehensive.input.ts
    const buttonClass = "css-39ccb25d";
    const primaryClass = "css-7a998145";
    const secondaryClass = "css-6c03a746";
    const importedClass = "css-4f842925";
    const nestedClass = "css-234be203";
    function getButtonClass() {
    	return "css-6c89bbd7";
    }

    //#endregion
    export { buttonClass, getButtonClass, importedClass, nestedClass, primaryClass, secondaryClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-348273b1 {
      /* red class */
      color: red;
    }
    .css-39ccb25d {
      /* button */
      border: 1px solid blue;
      padding: 10px;
    }

    .css-7a998145 {
      /* primary */
      color: blue;
    }

    .css-6c03a746 {
      /* secondary */
      color: green;
    }

    .css-f67b7304 {
      /* highlighted */
      color: red;

      &.css-af173032 {
        font-weight: bold;
      }
    }

    .css-4f842925 {
      /* imported */
      background: white;
      width: 40.123px;
      font-size: 16px;
      font-weight: bold;

      &.css-348273b1 {
        border-color: red;
      }
    }

    .css-234be203 {
      /* nested */
      background: gray;

      &.css-f67b7304 {
        color: red;
      }
    }

    .css-6c89bbd7 {
      /* inline css */
        background: blue;
        padding: 8px 16px;
    }
    "
  `);
});

test('generate hash based on file path relative to root and file name to avoid name conflicts', async () => {
  const fixturePath = import.meta.resolve('./fixtures/identical.input.ts');
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/identical-first.ts
    const myClass = "css-3f848070";

    //#endregion
    //#region test/fixtures/identical-second.ts
    const myClass$1 = "css-5a57e4d1";

    //#endregion
    export { myClass as firstClass, myClass$1 as secondClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-3f848070 {
      color: green;
    }
    .css-5a57e4d1 {
      color: green;
    }
    "
  `);
});

test('ignore non-ecij css tag functions', async () => {
  const fixturePath = import.meta.resolve('./fixtures/no-ecij.input.ts');
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/fake.ts
    function css(_) {
    	return "";
    }
    function unrelated(_) {
    	return "";
    }

    //#endregion
    //#region test/fixtures/no-ecij.input.ts
    const unknown = unrelated\`this is not css\`;
    const buttonClass = css\`
      color: blue;
      padding: 10px;
    \`;
    function getButtonClass() {
    	return css\`
        background: green;
        padding: 8px 16px;
      \`;
    }

    //#endregion
    export { buttonClass, getButtonClass, unknown };"
  `);

  // No CSS should be generated
  expect(result.css).toBeUndefined();
});

test('skip css blocks with complex interpolations', async () => {
  const fixturePath = import.meta
    .resolve('./fixtures/complex-interpolation.input.ts');
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }

    //#endregion
    //#region test/fixtures/complex-interpolation.input.ts
    const dynamicClass = css\`
      color: \${Math.random() > .5 ? "red" : "blue"};
      padding: 10px;
    \`;
    const unresolvedIdentifierClass = css\`
      color: \${unknownVariable};
    \`;

    //#endregion
    export { dynamicClass, unresolvedIdentifierClass };"
  `);

  // CSS blocks with complex expressions are skipped
  expect(result.css).toBeUndefined();
});

test('skip empty css blocks', async () => {
  const fixturePath = import.meta.resolve('./fixtures/empty-css.input.ts');
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/empty-css.input.ts
    const emptyClass = "css-f993173e";

    //#endregion
    export { emptyClass };"
  `);

  // No CSS should be generated
  expect(result.css).toBeUndefined();
});

test('classPrefix setting', async () => {
  const fixturePath = import.meta.resolve('./fixtures/basic.input.ts');
  const result = await buildWithPlugin(fixturePath, {
    classPrefix: 'custom_',
  });

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/basic.input.ts
    const basicClass = "custom_90f511d6";

    //#endregion
    export { basicClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".custom_90f511d6 {
      border: 1px solid blue;
      padding: 10px;
    }
    "
  `);
});
