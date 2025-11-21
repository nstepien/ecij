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
  // TODO:
  // - preserve redClass in the CSS output
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/comprehensive.input.ts
    const buttonClass = "css-39ccb25d";
    const primaryClass = "css-7a998145";
    const secondaryClass = "css-6c03a746";
    const importedClass = "css-873c0af7";
    const nestedClass = "css-558a1973";
    function getButtonClass() {
    	return "css-05de2aa1";
    }

    //#endregion
    export { buttonClass, getButtonClass, importedClass, nestedClass, primaryClass, secondaryClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-39ccb25d {
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

    .css-51df74aa {
      /* highlighted */
      color: red;
    }

    .css-873c0af7 {
      /* imported */
      background: white;
      width: 40.123px;

      &.css-348273b1 {
        border-color: red;
      }
    }

    .css-558a1973 {
      /* nested */
      background: gray;

      &.css-51df74aa {
        color: red;
      }
    }

    .css-05de2aa1 {
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

// TODO
test.fails('ignore non-ecij css tag functions', async () => {
  const fixturePath = import.meta.resolve('./fixtures/no-ecij.input.ts');
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/fake.ts
    function unrelated(_) {
    	return "";
    }

    //#endregion
    //#region test/fixtures/no-ecij.input.ts
    const unknown = unrelated\`this is not css\`;
    const buttonClass = "css-25e9670b";

    //#endregion
    export { buttonClass, unknown };"
  `);

  // No CSS should be generated
  expect(result.css).toBeUndefined();
});

test('skip css blocks with complex interpolations', async () => {
  const fixturePath = import.meta.resolve(
    './fixtures/complex-interpolation.input.ts',
  );
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
