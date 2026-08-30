import { originalPositionFor, TraceMap, type EncodedSourceMap } from '@jridgewell/trace-mapping';
import { ecij, type Configuration } from 'ecij/plugin';
import { rolldown, type OutputAsset, type RolldownLog } from 'rolldown';
import { build } from 'vite';
import { assert, expect, test } from 'vitest';

const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^.*\/test\//, 'test/');

// Helper to run a vite build with the ecij plugin
async function buildWithPlugin(
  entry: string,
  pluginOptions?: Configuration,
  buildOptions?: { external?: string[]; sourcemap?: boolean },
) {
  const sourcemap = buildOptions?.sourcemap ?? false;
  const logs: RolldownLog[] = [];

  const output = await build({
    build: {
      lib: {
        entry,
        formats: ['es'],
      },
      minify: false,
      write: false,
      sourcemap,
      rolldownOptions: {
        ...(buildOptions?.external === undefined ? {} : { external: buildOptions.external }),
        onLog(level, log, handler) {
          if (log.plugin === 'ecij') {
            // Normalize absolute paths so snapshots are stable across machines
            if (log.id !== undefined) {
              log.id = normalize(log.id);
            }
            if (log.loc?.file !== undefined) {
              log.loc.file = normalize(log.loc.file);
            }
            logs.push(log);
          } else {
            handler(level, log);
          }
        },
      },
    },
    plugins: [ecij(pluginOptions)],
    logLevel: 'warn',
  });

  if (!Array.isArray(output)) {
    throw new Error('Expected output to be an array of chunks');
  }

  const chunks = output.flatMap((chunk) => chunk.output);

  // Should only have JS and CSS outputs, plus the JS sourcemap when enabled
  expect(chunks.length).toBeLessThanOrEqual(sourcemap ? 3 : 2);

  // Extract JS and CSS chunks
  const jsChunk = chunks.find((chunk) => chunk.type === 'chunk');
  const cssChunk = chunks.find(
    (chunk): chunk is OutputAsset => chunk.type === 'asset' && chunk.fileName.endsWith('.css'),
  );

  return {
    js: jsChunk?.code.trim(),
    css: (cssChunk?.source as string | undefined)?.trim(),
    map: jsChunk?.map,
    logs,
  };
}

test('comprehensive CSS-in-JS patterns', async () => {
  const fixturePath = './test/fixtures/comprehensive.input.ts';
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
    var buttonClass = "css-39ccb25d";
    var primaryClass = "css-7a998145";
    var secondaryClass = "css-6c03a746";
    var importedClass = "css-4f842925";
    var nestedClass = "css-234be203";
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
    }.css-39ccb25d {
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
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('emit sourcemaps for transformed modules without sourcemap warnings', async () => {
  const fixturePath = './test/fixtures/comprehensive.input.ts';
  const { js, map, logs } = await buildWithPlugin(fixturePath, undefined, { sourcemap: true });

  // No SOURCEMAP_BROKEN warnings should be emitted for the plugin's transforms
  expect(logs).toStrictEqual([]);

  assert(map != null, 'Expected the JS chunk to have a sourcemap');

  expect(map.sources).toStrictEqual(['../test/fixtures/comprehensive.input.ts']);
  expect(map.mappings).not.toBe('');

  // The generated class name string should map back to the position of
  // the css`` tagged template it replaced in the original source
  const generatedLines = js!.split('\n');
  const generatedLine = generatedLines.findIndex((line) => line.includes('"css-39ccb25d"'));
  expect(generatedLine).not.toBe(-1);

  const originalPosition = originalPositionFor(new TraceMap(map as EncodedSourceMap), {
    line: generatedLine + 1,
    column: generatedLines[generatedLine]!.indexOf('"css-39ccb25d"'),
  });

  // `buttonClass` is declared on line 7 of the fixture,
  // with its css`` tag starting at column 27
  expect(originalPosition).toStrictEqual({
    source: '../test/fixtures/comprehensive.input.ts',
    line: 7,
    column: 27,
    name: null,
  });
});

test('generate hash based on file path relative to root and file name to avoid name conflicts', async () => {
  const fixturePath = './test/fixtures/identical.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/identical-first.ts
    var myClass = "css-3f848070";
    //#endregion
    //#region test/fixtures/identical-second.ts
    var myClass$1 = "css-5a57e4d1";
    //#endregion
    export { myClass as firstClass, myClass$1 as secondClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-3f848070 {
      color: green;
    }.css-5a57e4d1 {
      color: green;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('ignore non-ecij css tag functions', async () => {
  const fixturePath = './test/fixtures/no-ecij.input.ts';
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
    var unknown = unrelated\`this is not css\`;
    var buttonClass = css\`
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
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('skip css blocks with complex interpolations', async () => {
  const fixturePath = './test/fixtures/complex-interpolation.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/complex-interpolation.input.ts
    var dynamicClass = css\`
      color: \${Math.random() > .5 ? "red" : "blue"};
      padding: 10px;
    \`;
    var unresolvedIdentifierClass = css\`
      color: \${unknownVariable};
    \`;
    //#endregion
    export { dynamicClass, unresolvedIdentifierClass };"
  `);

  // CSS blocks with complex expressions are skipped
  expect(result.css).toBeUndefined();
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "1: import { css } from "ecij";
    2: export const dynamicClass = css\`
    3:   color: \${Math.random() > .5 ? "red" : "blue"};
                  ^
    4:   padding: 10px;
    5: \`;",
        "hook": "transform",
        "id": "test/fixtures/complex-interpolation.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/complex-interpolation.input.ts",
          "line": 3,
        },
        "message": "skipped CSS extraction — interpolation is not a static string, number, or identifier",
        "plugin": "ecij",
        "pluginCode": "COMPLEX_INTERPOLATION",
        "pos": 72,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "5: \`;
    6: export const unresolvedIdentifierClass = css\`
    7:   color: \${unknownVariable};
                  ^
    8: \`;",
        "hook": "transform",
        "id": "test/fixtures/complex-interpolation.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/complex-interpolation.input.ts",
          "line": 7,
        },
        "message": "skipped CSS extraction — could not resolve "unknownVariable" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 187,
      },
    ]
  `);
});

test('inline string and number literal interpolations', async () => {
  const fixturePath = './test/fixtures/literal-interpolation.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/literal-interpolation.input.ts
    var stringLiteralClass = "css-1c8f4a51";
    var numberLiteralClass = "css-25b58437";
    var mixedClass = "css-0a775b56";
    var negativeNumberClass = "css-f5d083cc";
    var unaryPlusClass = "css-3924bbbe";
    var booleanLiteralClass = css\`
      color: \${true};
    \`;
    //#endregion
    export { booleanLiteralClass, mixedClass, negativeNumberClass, numberLiteralClass, stringLiteralClass, unaryPlusClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-1c8f4a51 {
      color: blue;
    }

    .css-25b58437 {
      width: 42px;
      opacity: 0.5;
    }

    .css-0a775b56 {
      color: red;
      font-size: 16px;
      background: white;
    }

    .css-f5d083cc {
      margin: -5px;
      letter-spacing: -0.25em;
    }

    .css-3924bbbe {
      width: 10px;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "21: \`;
    22: export const booleanLiteralClass = css\`
    23:   color: \${true};
                   ^
    24: \`;",
        "hook": "transform",
        "id": "test/fixtures/literal-interpolation.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/literal-interpolation.input.ts",
          "line": 23,
        },
        "message": "skipped CSS extraction — interpolation is not a static string, number, or identifier",
        "plugin": "ecij",
        "pluginCode": "COMPLEX_INTERPOLATION",
        "pos": 497,
      },
    ]
  `);
});

test('skip empty css blocks', async () => {
  const fixturePath = './test/fixtures/empty-css.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/empty-css.input.ts
    var emptyClass = "css-f993173e";
    //#endregion
    export { emptyClass };"
  `);

  // No CSS should be generated
  expect(result.css).toBeUndefined();
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('variable scoping and shadowing', async () => {
  const fixturePath = './test/fixtures/scoping.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/scoping.input.ts
    var topLevelStyle = "css-0195f7e3";
    function functionShadow() {
    	return "css-411204c9";
    }
    var afterFunctionShadow = "css-8a8b8960";
    function level1() {
    	function level2() {
    		function level3() {
    			return "css-659695df";
    		}
    		return {
    			l2style: "css-3d6fa251",
    			level3: level3()
    		};
    	}
    	return {
    		l1style: "css-cde0a254",
    		level2: level2()
    	};
    }
    var afterNestedFunctions = "css-99472906";
    var arrowShadow = () => {
    	return "css-17f33205";
    };
    var afterArrowShadow = "css-51830571";
    function blockScope() {
    	const beforeBlock = "css-ccba37a0";
    	console.log("css-6735f3b4");
    	return {
    		beforeBlock,
    		afterBlock: "css-65e6a255"
    	};
    }
    function shadowsImport() {
    	return "css-225f18cd";
    }
    var usesImport = "css-61cf5dea";
    var usesImportedClass = "css-4d5166f1";
    function shadowsCssClass() {
    	return "css-9ce6da78";
    }
    var usesBaseClass = "css-ffc7c674";
    function varDeclaration() {
    	return "css-68d2d974";
    }
    var afterVarDecl = "css-5519aacd";
    function multiShadow() {
    	return "css-6946e38a";
    }
    var afterMultiShadow = "css-dd6f0f89";
    function sequentialBlocks() {
    	console.log("css-4156e44e");
    	console.log("css-1890c5b2");
    	return "css-980c7373";
    }
    function deeplyNested() {
    	const outerFn = () => {
    		function inner() {
    			console.log("css-81becece");
    			return "css-5866845a";
    		}
    		return {
    			arrowStyle: "css-92f15a0f",
    			inner: inner()
    		};
    	};
    	return {
    		outerStyle: "css-373046c6",
    		outerFn: outerFn()
    	};
    }
    var finalModuleStyle = "css-157eeb32";
    //#endregion
    export { afterArrowShadow, afterFunctionShadow, afterMultiShadow, afterNestedFunctions, afterVarDecl, arrowShadow, blockScope, deeplyNested, finalModuleStyle, functionShadow, level1, multiShadow, sequentialBlocks, shadowsCssClass, shadowsImport, topLevelStyle, usesBaseClass, usesImport, usesImportedClass, varDeclaration };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-9cfab70f {
      /* accent */
      background: crimson;
      font-size: 14px;
    }.css-0195f7e3 {
      color: red;
      font-size: 16px;
      font-weight: bold;
    }

    .css-411204c9 {
      color: blue;
        font-size: 16px;
    }

    .css-8a8b8960 {
      color: red;
    }

    .css-659695df {
      color: orange;
            padding: 20px;
            margin: 10px;
    }

    .css-3d6fa251 {
      color: purple;
          margin: 10px;
    }

    .css-cde0a254 {
      color: green;
        padding: 10px;
    }

    .css-99472906 {
      color: red;
    }

    .css-17f33205 {
      color: cyan;
    }

    .css-51830571 {
      color: red;
    }

    .css-ccba37a0 {
      background: white;
    }

    .css-6735f3b4 {
      background: black;
    }

    .css-65e6a255 {
      background: white;
    }

    .css-225f18cd {
      color: black;
    }

    .css-61cf5dea {
      color: crimson;
      font-size: 14px;
    }

    .css-4d5166f1 {
      &.css-9cfab70f {
        display: block;
      }
    }

    .css-336338e2 {
      display: flex;
    }

    .css-391f07e4 {
      display: grid;
    }

    .css-9ce6da78 {
      &.css-391f07e4 {
          gap: 10px;
        }
    }

    .css-ffc7c674 {
      &.css-336338e2 {
        align-items: center;
      }
    }

    .css-68d2d974 {
      color: magenta;
    }

    .css-5519aacd {
      color: red;
    }

    .css-6946e38a {
      color: silver;
        font-size: 32px;
        font-weight: 100;
    }

    .css-dd6f0f89 {
      color: red;
      font-size: 16px;
      font-weight: bold;
    }

    .css-4156e44e {
      color: navy;
    }

    .css-1890c5b2 {
      color: olive;
    }

    .css-980c7373 {
      color: red;
    }

    .css-81becece {
      color: ivory;
    }

    .css-5866845a {
      color: wheat;
    }

    .css-92f15a0f {
      color: salmon;
    }

    .css-373046c6 {
      color: coral;
    }

    .css-157eeb32 {
      color: red;
      font-size: 16px;
      font-weight: bold;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('advanced scoping: function parameters, for-of/in, catch, static blocks', async () => {
  const fixturePath = './test/fixtures/scoping-advanced.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/scoping-advanced.input.ts
    function paramShadow(color) {
    	return css\`
        color: \${color};
      \`;
    }
    var arrowParamShadow = (color) => {
    	return css\`
        color: \${color};
      \`;
    };
    var arrowExprParam = (color) => css\`
        color: \${color};
      \`;
    function paramPartialShadow(color) {
    	return "css-72a8e6d6";
    }
    function forOfShadow() {
    	for (const color of ["blue", "green"]) console.log(css\`
            color: \${color};
          \`);
    	return "css-6243fe14";
    }
    function forInShadow() {
    	for (const color in { blue: 1 }) console.log(css\`
            color: \${color};
          \`);
    	return "css-330916ac";
    }
    function catchShadow() {
    	try {
    		throw new Error();
    	} catch (color) {
    		console.log(css\`
            color: \${color};
          \`);
    	}
    	return "css-a30d4f0f";
    }
    function letNoInit() {
    	return css\`
        color: \${"dynamic"};
      \`;
    }
    function nonLiteralInit() {
    	return css\`
        color: \${String("blue")};
      \`;
    }
    function defaultParam(color = "blue") {
    	return css\`
        color: \${color};
      \`;
    }
    function forStatementShadow() {
    	for (let color = "blue"; color !== "done"; color = "done") console.log("css-c7155baa");
    	return "css-f19ded5e";
    }
    var MyClass = class MyClass {
    	static style;
    	static {
    		MyClass.style = "css-5f19011e";
    	}
    };
    function fnDeclShadow() {
    	function color() {}
    	return css\`
        color: \${color};
      \`;
    }
    function classDeclShadow() {
    	class color {}
    	return css\`
        color: \${color};
      \`;
    }
    function fnExprName() {
    	return "css-c8fe0069";
    }
    var fnExprNameInner = function color() {
    	return css\`
        color: \${color};
      \`;
    };
    var classExprNameInner = class color {
    	static style = css\`
        color: \${color};
      \`;
    };
    var classExprName = class color {};
    var afterClassExpr = "css-9c55bf3b";
    function arrayDestructuring() {
    	const [color] = ["blue"];
    	return css\`
        color: \${color};
      \`;
    }
    function objectDestructuring() {
    	const { color } = { color: "blue" };
    	return css\`
        color: \${color};
      \`;
    }
    function forOfDestructuring() {
    	for (const [color] of [["blue"]]) console.log(css\`
            color: \${color};
          \`);
    	return "css-fd3f8093";
    }
    function destructuredParam({ color }) {
    	return css\`
        color: \${color};
      \`;
    }
    function varInBlock() {
    	console.log("css-b7f7cd35");
    	return "css-14873b06";
    }
    function varForOf() {
    	for (var color of ["blue", "green"]) console.log(css\`
            color: \${color};
          \`);
    	return css\`
        color: \${color};
      \`;
    }
    function varForIn() {
    	for (var color in { blue: 1 }) console.log(css\`
            color: \${color};
          \`);
    	return css\`
        color: \${color};
      \`;
    }
    function objectRestShadow() {
    	const { ...color } = { color: "blue" };
    	return css\`
        color: \${color};
      \`;
    }
    function arrayRestShadow() {
    	const [, ...color] = [
    		"a",
    		"b",
    		"c"
    	];
    	return css\`
        color: \${color};
      \`;
    }
    function restParamShadow(...color) {
    	return css\`
        color: \${color};
      \`;
    }
    function switchScope(value) {
    	switch (value) {
    		case "a": console.log("css-9c07daeb");
    	}
    	return "css-98764909";
    }
    function tag(_) {
    	return "";
    }
    function nonCssTaggedShadow() {
    	return css\`
        color: \${tag\`anything\`};
      \`;
    }
    function booleanLiteralShadow() {
    	return css\`
        color: \${true};
      \`;
    }
    function varDeclaredInBlock() {
    	return "css-338b1b83";
    }
    function varDeclaredInLoop() {
    	for (const color of ["green", "purple"]) {
    		var perIteration = css\`
          color: \${color};
        \`;
    		console.log(perIteration);
    	}
    }
    var finalModuleCheck = "css-361b5f22";
    //#endregion
    export { MyClass, afterClassExpr, arrayDestructuring, arrayRestShadow, arrowExprParam, arrowParamShadow, booleanLiteralShadow, catchShadow, classDeclShadow, classExprName, classExprNameInner, defaultParam, destructuredParam, finalModuleCheck, fnDeclShadow, fnExprName, fnExprNameInner, forInShadow, forOfDestructuring, forOfShadow, forStatementShadow, letNoInit, nonCssTaggedShadow, nonLiteralInit, objectDestructuring, objectRestShadow, paramPartialShadow, paramShadow, restParamShadow, switchScope, varDeclaredInBlock, varDeclaredInLoop, varForIn, varForOf, varInBlock };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-72a8e6d6 {
      font-size: 16px;
    }

    .css-6243fe14 {
      color: red;
    }

    .css-330916ac {
      color: red;
    }

    .css-a30d4f0f {
      color: red;
    }

    .css-c7155baa {
      color: blue;
    }

    .css-f19ded5e {
      color: red;
    }

    .css-5f19011e {
      color: purple;
    }

    .css-c8fe0069 {
      color: red;
    }

    .css-9c55bf3b {
      color: red;
    }

    .css-fd3f8093 {
      color: red;
    }

    .css-b7f7cd35 {
      color: blue;
    }

    .css-14873b06 {
      color: blue;
    }

    .css-9c07daeb {
      color: blue;
    }

    .css-98764909 {
      color: red;
    }

    .css-c5b52b7e {
      color: blue;
          font-size: 16px;
    }

    .css-2a8701d8 {
      padding: 4px;
    }

    .css-338b1b83 {
      &.css-c5b52b7e,
        &.css-2a8701d8 {
          color: red;
        }
    }

    .css-361b5f22 {
      color: red;
      font-size: 16px;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "4: export function paramShadow(color) {
    5:   return css\`
    6:     color: \${color};
                    ^
    7:   \`;
    8: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 6,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 133,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": " 9: export const arrowParamShadow = (color) => {
    10:   return css\`
    11:     color: \${color};
                     ^
    12:   \`;
    13: };",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 11,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 219,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "13: };
    14: export const arrowExprParam = (color) => css\`
    15:     color: \${color};
                     ^
    16:   \`;
    17: export function paramPartialShadow(color) {",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 15,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 294,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "23:   for (const color of ["blue", "green"]) {
    24:     console.log(css\`
    25:         color: \${color};
                         ^
    26:       \`);
    27:   }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 17,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 25,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 505,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "33:   for (const color in { blue: 1 }) {
    34:     console.log(css\`
    35:         color: \${color};
                         ^
    36:       \`);
    37:   }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 17,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 35,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 671,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "45:   } catch (color) {
    46:     console.log(css\`
    47:         color: \${color};
                         ^
    48:       \`);
    49:   }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 17,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 47,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 848,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "56:   color = "dynamic";
    57:   return css\`
    58:     color: \${color};
                     ^
    59:   \`;
    60: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 58,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 998,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "62:   const color = String("blue");
    63:   return css\`
    64:     color: \${color};
                     ^
    65:   \`;
    66: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 64,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 1105,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "67: export function defaultParam(color = "blue") {
    68:   return css\`
    69:     color: \${color};
                     ^
    70:   \`;
    71: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 69,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 1193,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "92:   function color() {}
    93:   return css\`
    94:     color: \${color};
                     ^
    95:   \`;
    96: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 94,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 1619,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": " 98:   class color {}
     99:   return css\`
    100:     color: \${color};
                      ^
    101:   \`;
    102: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 100,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 1712,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "110: export const fnExprNameInner = function color() {
    111:   return css\`
    112:     color: \${color};
                      ^
    113:   \`;
    114: };",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 112,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 1918,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "115: export const classExprNameInner = class color {
    116:   static style = css\`
    117:     color: \${color};
                      ^
    118:   \`;
    119: };",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 117,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2016,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "125:   const [color] = ["blue"];
    126:   return css\`
    127:     color: \${color};
                      ^
    128:   \`;
    129: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 127,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2226,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "131:   const { color } = { color: "blue" };
    132:   return css\`
    133:     color: \${color};
                      ^
    134:   \`;
    135: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 133,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2345,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "137:   for (const [color] of [["blue"]]) {
    138:     console.log(css\`
    139:         color: \${color};
                          ^
    140:       \`);
    141:   }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 17,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 139,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2472,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "146: export function destructuredParam({ color }) {
    147:   return css\`
    148:     color: \${color};
                      ^
    149:   \`;
    150: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 148,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2607,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "164:   for (var color of ["blue", "green"]) {
    165:     console.log(css\`
    166:         color: \${color};
                          ^
    167:       \`);
    168:   }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 17,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 166,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2904,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "168:   }
    169:   return css\`
    170:     color: \${color};
                      ^
    171:   \`;
    172: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 170,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 2951,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "174:   for (var color in { blue: 1 }) {
    175:     console.log(css\`
    176:         color: \${color};
                          ^
    177:       \`);
    178:   }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 17,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 176,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3065,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "178:   }
    179:   return css\`
    180:     color: \${color};
                      ^
    181:   \`;
    182: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 180,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3112,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "184:   const { ...color } = { color: "blue" };
    185:   return css\`
    186:     color: \${color};
                      ^
    187:   \`;
    188: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 186,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3231,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "194:   ];
    195:   return css\`
    196:     color: \${color};
                      ^
    197:   \`;
    198: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 196,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3356,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "199: export function restParamShadow(...color) {
    200:   return css\`
    201:     color: \${color};
                      ^
    202:   \`;
    203: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 201,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3441,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "223:   const color = tag\`anything\`;
    224:   return css\`
    225:     color: \${color};
                      ^
    226:   \`;
    227: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 225,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3812,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "229:   const color = true;
    230:   return css\`
    231:     color: \${color};
                      ^
    232:   \`;
    233: }",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 231,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 3915,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "254:   for (const color of ["green", "purple"]) {
    255:     var perIteration = css\`
    256:       color: \${color};
                        ^
    257:     \`;
    258:     console.log(perIteration);",
        "hook": "transform",
        "id": "test/fixtures/scoping-advanced.input.ts",
        "loc": {
          "column": 15,
          "file": "test/fixtures/scoping-advanced.input.ts",
          "line": 256,
        },
        "message": "skipped CSS extraction — could not resolve "color" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 4365,
      },
    ]
  `);
});

test('default, namespace, and re-exported imports/exports', async () => {
  const fixturePath = './test/fixtures/import-export.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // Covers:
  // - `export default css\`...\``
  // - `export default <literal>` and `export default <local>`
  // - `import defaultName from 'mod'`
  // - `import * as ns from 'mod'` with `${ns.foo}` member access
  // - `export { x } from 'mod'` and `export { x as y } from 'mod'`
  // - `export { default as foo } from 'mod'`
  // - `export { foo as default } from 'mod'`
  // - `export * from 'mod'` (excludes the default export)
  // - `export * as ns from 'mod'` accessed through a named import
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/import-export.input.ts
    var usesDefaultCssClass = "css-b0b5a725";
    var usesDefaultLiteral = "css-cba05f2f";
    var usesDefaultLocalClass = "css-c157f391";
    var usesNamespaceImport = "css-f1972a30";
    var usesReexportNamed = "css-068fc5a6";
    var usesReexportDefaultAsNamed = "css-49a2e17a";
    var usesReexportNamedAsDefault = "css-6677b97e";
    var usesStarReexport = "css-51c1a4dd";
    var usesNamespaceReexport = "css-258eae2b";
    var import_export_input_default = "css-00ba416b";
    //#endregion
    export { import_export_input_default as default, usesDefaultCssClass, usesDefaultLiteral, usesDefaultLocalClass, usesNamespaceImport, usesNamespaceReexport, usesReexportDefaultAsNamed, usesReexportNamed, usesReexportNamedAsDefault, usesStarReexport };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-2c1bb3ca {
      /* default css */
      border: 2px dashed teal;
    }.css-be832145 {
      /* default-local */
      display: grid;
    }.css-9cfab70f {
      /* accent */
      background: crimson;
      font-size: 14px;
    }.css-b0b5a725 {
      /* uses default-css */
      &.css-2c1bb3ca {
        color: red;
      }
    }

    .css-cba05f2f {
      /* uses default-literal */
      color: royalblue;
    }

    .css-c157f391 {
      /* uses default-local */
      &.css-be832145 {
        border: 1px solid;
      }
    }

    .css-f1972a30 {
      /* uses namespace */
      background: crimson;
      font-size: 14px;

      &.css-9cfab70f {
        color: red;
      }
    }

    .css-068fc5a6 {
      /* uses reexport-named */
      color: crimson;

      &.css-9cfab70f {
        color: red;
      }
    }

    .css-49a2e17a {
      /* uses reexport-default-as-named */
      &.css-2c1bb3ca {
        color: red;
      }
    }

    .css-6677b97e {
      /* uses reexport-named-as-default */
      color: crimson;
    }

    .css-51c1a4dd {
      /* uses star-reexport */
      color: crimson;

      &.css-9cfab70f {
        color: red;
      }
    }

    .css-258eae2b {
      /* uses namespace-reexport */
      background: crimson;

      &.css-9cfab70f {
        color: red;
      }
    }

    .css-00ba416b {
      /* entry-default */
      font-size: 12px;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('barrel files: `export *` aggregation and explicit-over-star precedence', async () => {
  const fixturePath = './test/fixtures/barrel.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // - `aColor` is re-exported from `./barrel-a` via `export *` *and* declared
  //   locally as `export const aColor = 'locally-overridden'` in the barrel.
  //   The explicit local export must win.
  // - `aClass` resolves through `export * from './barrel-a'`
  // - `bColor`/`bClass` resolve through `export * from './barrel-b'`
  // - `shared` is exposed by both `export { shared } from './barrel-c'` (c-wins)
  //   and `export * from './barrel-b'` (b-loses); explicit re-export must win.
  // - `barrel-nested.ts` re-exports `aClass` again — it should not double up.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/barrel.input.ts
    var usesBarrelA = "css-6a28b4b6";
    var usesBarrelB = "css-2f855474";
    var usesBarrelShared = "css-7c6ff0f4";
    var usesBarrelDeep = "css-147baedb";
    //#endregion
    export { usesBarrelA, usesBarrelB, usesBarrelDeep, usesBarrelShared };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-1936cac6 {
      /* a */
      color: aqua;
    }.css-ad2da54d {
      /* b */
      color: beige;
    }.css-6a28b4b6 {
      /* uses-a */
      color: locally-overridden;

      &.css-1936cac6 {
        color: red;
      }
    }

    .css-2f855474 {
      /* uses-b */
      color: beige;

      &.css-ad2da54d {
        color: red;
      }
    }

    .css-7c6ff0f4 {
      /* uses-shared */
      color: c-wins;
    }

    .css-147baedb {
      /* uses-deep */
      color: darkcyan;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('namespace edge cases: unknown member, namespace-as-scalar, ns-reexport-as-scalar', async () => {
  const fixturePath = './test/fixtures/namespace-edge-cases.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // - `${ns.unknownMember}` should warn that the member couldn't be resolved.
  // - `${ns}` (namespace import used as scalar) should warn — namespaces have no
  //   single-value reduction.
  // - `${reexportedNs}` (a namespace reached through `export * as`, used as
  //   scalar) should warn for the same reason.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region \\0rolldown/runtime.js
    var __defProp = Object.defineProperty;
    var __exportAll = (all, no_symbols) => {
    	let target = {};
    	for (var name in all) __defProp(target, name, {
    		get: all[name],
    		enumerable: true
    	});
    	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
    	return target;
    };
    //#endregion
    //#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/named-styles.ts
    var named_styles_exports = /* @__PURE__ */ __exportAll({
    	accentClass: () => accentClass,
    	accentColor: () => accentColor,
    	accentSize: () => 14
    });
    var accentColor = "crimson";
    var accentClass = "css-9cfab70f";
    //#endregion
    //#region test/fixtures/namespace-edge-cases.input.ts
    var missingMember = css\`
      color: \${void 0};
    \`;
    var namespaceAsScalar = css\`
      color: \${named_styles_exports};
    \`;
    var namespaceReexportAsScalar = css\`
      color: \${named_styles_exports};
    \`;
    var starDefaultAsScalar = css\`
      color: \${void 0};
    \`;
    //#endregion
    export { missingMember, namespaceAsScalar, namespaceReexportAsScalar, starDefaultAsScalar };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-9cfab70f {
      /* accent */
      background: crimson;
      font-size: 14px;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "4: import * as starOnly from "./star-over-default";
    5: export const missingMember = css\`
    6:   color: \${namedStyles.unknownMember};
                  ^
    7: \`;
    8: export const namespaceAsScalar = css\`",
        "hook": "transform",
        "id": "test/fixtures/namespace-edge-cases.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/namespace-edge-cases.input.ts",
          "line": 6,
        },
        "message": "skipped CSS extraction — could not resolve "namedStyles.unknownMember" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 217,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": " 7: \`;
     8: export const namespaceAsScalar = css\`
     9:   color: \${namedStyles};
                   ^
    10: \`;
    11: export const namespaceReexportAsScalar = css\`",
        "hook": "transform",
        "id": "test/fixtures/namespace-edge-cases.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/namespace-edge-cases.input.ts",
          "line": 9,
        },
        "message": "skipped CSS extraction — could not resolve "namedStyles" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 297,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "10: \`;
    11: export const namespaceReexportAsScalar = css\`
    12:   color: \${styles};
                   ^
    13: \`;
    14: export const starDefaultAsScalar = css\`",
        "hook": "transform",
        "id": "test/fixtures/namespace-edge-cases.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/namespace-edge-cases.input.ts",
          "line": 12,
        },
        "message": "skipped CSS extraction — could not resolve "styles" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 371,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "13: \`;
    14: export const starDefaultAsScalar = css\`
    15:   color: \${starOnly.default};
                   ^
    16: \`;",
        "hook": "transform",
        "id": "test/fixtures/namespace-edge-cases.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/namespace-edge-cases.input.ts",
          "line": 15,
        },
        "message": "skipped CSS extraction — could not resolve "starOnly.default" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 434,
      },
    ]
  `);
});

test('self-referencing barrel resolves without deadlocking', async () => {
  const fixturePath = './test/fixtures/self-barrel.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // The barrel `export *`s the entry itself; probing that star source must not
  // `context.load` the in-flight module (which would deadlock the build), and
  // `tokenColor` must still resolve through the barrel's other star source.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/self-barrel.input.ts
    var selfBarrelClass = "css-a96da074";
    //#endregion
    export { selfBarrelClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-a96da074 {
      /* self-barrel */
      color: teal;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('external modules in `export *` chains are skipped gracefully', async () => {
  const fixturePath = './test/fixtures/external-star.input.ts';
  const result = await buildWithPlugin(fixturePath, undefined, { external: ['@acme/tokens'] });

  // The barrel's first star source is external — it cannot be parsed and must
  // not be loaded; `brandColor` resolves from the local star source instead.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/external-star.input.ts
    var usesExternalBarrel = "css-ff9a316e";
    //#endregion
    export { usesExternalBarrel };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-ff9a316e {
      /* uses external-barrel */
      color: goldenrod;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('explicit exports with non-static values shadow `export *` sources', async () => {
  const fixturePath = './test/fixtures/star-precedence.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // The barrel explicitly exports `tone = computeTone()` (not statically
  // resolvable) while `export *` provides a static `tone` from another module.
  // Per ESM the explicit export wins, so the plugin must warn and skip rather
  // than bake the star source's 'aqua'.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/star-precedence.ts
    function computeTone() {
    	return "runtime-only";
    }
    //#endregion
    //#region test/fixtures/star-precedence.input.ts
    var usesShadowedTone = css\`
      /* uses shadowed-tone */
      color: \${computeTone()};
    \`;
    //#endregion
    export { usesShadowedTone };"
  `);
  expect(result.css).toMatchInlineSnapshot(`undefined`);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "3: export const usesShadowedTone = css\`
    4:   /* uses shadowed-tone */
    5:   color: \${tone};
                  ^
    6: \`;",
        "hook": "transform",
        "id": "test/fixtures/star-precedence.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/star-precedence.input.ts",
          "line": 5,
        },
        "message": "skipped CSS extraction — could not resolve "tone" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 145,
      },
    ]
  `);
});

test('import/export hardening: default passthrough, chained namespaces, static default exports', async () => {
  const fixturePath = './test/fixtures/import-export-hardening.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // Covers:
  // - `import d from 'mod'; export { d };` resolving to mod's *default* export
  //   (not the decoy named export with the same name)
  // - `export * as ns` reached through a chained named re-export
  // - `export * as ns` reached through an `export *` hop
  // - nested namespace member access (`ns.inner.member`)
  // - `export default -5` (signed number literal)
  // - `export default css\`...\` as string` (wrapped css tagged template)
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/import-export-hardening.input.ts
    var usesPassthroughDefault = "css-f8cd4db8";
    var usesChainedNamespace = "css-dc153ecc";
    var usesStarChainedNamespace = "css-d6528605";
    var usesNestedNamespaceMember = "css-e6f5d50f";
    var usesNegativeDefault = "css-8f4583c7";
    var usesWrappedDefaultCss = "css-12e33db5";
    //#endregion
    export { usesChainedNamespace, usesNegativeDefault, usesNestedNamespaceMember, usesPassthroughDefault, usesStarChainedNamespace, usesWrappedDefaultCss };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-9cfab70f {
      /* accent */
      background: crimson;
      font-size: 14px;
    }.css-fb083c1c {
      /* wrapped-default */
      display: flex;
    }.css-f8cd4db8 {
      /* uses passthrough-default */
      color: mediumseagreen;
    }

    .css-dc153ecc {
      /* uses chained-namespace */
      color: crimson;
    }

    .css-d6528605 {
      /* uses star-chained-namespace */
      font-size: 14px;
    }

    .css-e6f5d50f {
      /* uses nested-namespace-member */
      background: crimson;

      &.css-9cfab70f {
        color: red;
      }
    }

    .css-8f4583c7 {
      /* uses negative-default */
      margin: -5px;
    }

    .css-12e33db5 {
      /* uses wrapped-default-css */
      &.css-fb083c1c {
        color: red;
      }
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('ambiguous `export *` names are not silently resolved', async () => {
  const fixturePath = './test/fixtures/ambiguous.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // `accent` is provided by two star sources with different bindings — per
  // ESM the name is ambiguous and excluded from the namespace object, so the
  // plugin must warn instead of picking the first source's value.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/ambiguous.input.ts
    var usesAmbiguous = css\`
      color: \${void 0};
    \`;
    //#endregion
    export { usesAmbiguous };"
  `);
  expect(result.css).toMatchInlineSnapshot(`undefined`);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "2: import * as ambiguous from "./ambiguous-barrel";
    3: export const usesAmbiguous = css\`
    4:   color: \${ambiguous.accent};
                  ^
    5: \`;",
        "hook": "transform",
        "id": "test/fixtures/ambiguous.input.ts",
        "loc": {
          "column": 11,
          "file": "test/fixtures/ambiguous.input.ts",
          "line": 4,
        },
        "message": "skipped CSS extraction — could not resolve "ambiguous.accent" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 122,
      },
    ]
  `);
});

test('class names from skipped extractions do not leak to consumers', async () => {
  const fixturePath = './test/fixtures/broken-export.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // broken-export's declaration fails extraction (complex interpolation), so
  // its class has no rule anywhere — the consumer must warn and skip instead
  // of inlining a phantom class name.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/broken-export.ts
    function dynamicPadding() {
    	return 4;
    }
    //#endregion
    //#region test/fixtures/broken-export.input.ts
    var usesBrokenClass = css\`
      &.\${css\`
      padding: \${dynamicPadding()}px;
    \`} {
        color: red;
      }
    \`;
    //#endregion
    export { usesBrokenClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`undefined`);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "4: }
    5: export const brokenClass = css\`
    6:   padding: \${dynamicPadding()}px;
                    ^
    7: \`;",
        "hook": "transform",
        "id": "test/fixtures/broken-export.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/broken-export.ts",
          "line": 6,
        },
        "message": "skipped CSS extraction — interpolation is not a static string, number, or identifier",
        "plugin": "ecij",
        "pluginCode": "COMPLEX_INTERPOLATION",
        "pos": 114,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "2: import { brokenClass } from "./broken-export";
    3: export const usesBrokenClass = css\`
    4:   &.\${brokenClass} {
             ^
    5:     color: red;
    6:   }",
        "hook": "transform",
        "id": "test/fixtures/broken-export.input.ts",
        "loc": {
          "column": 6,
          "file": "test/fixtures/broken-export.input.ts",
          "line": 4,
        },
        "message": "skipped CSS extraction — could not resolve "brokenClass" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 117,
      },
    ]
  `);
});

test('type-only imports/exports are ignored (plain rolldown, raw TypeScript)', async () => {
  // Unlike the Vite pipeline (which strips TypeScript before plugin
  // transforms run), plain rolldown hands raw TypeScript to the plugin — this
  // exercises the plugin's own `isType` handling for `import type`,
  // `import { type x }`, `export type { x } from`, `export { type x } from`,
  // and `export type * from`.
  const logs: RolldownLog[] = [];
  // Plain rolldown does not bundle CSS itself — collect the virtual CSS
  // modules the plugin emits instead.
  const cssModules = new Map<string, string>();

  const bundle = await rolldown({
    input: './test/fixtures/typed.input.ts',
    plugins: [
      ecij(),
      {
        name: 'collect-css',
        transform: {
          filter: { id: /\.css$/ },
          handler(code, id) {
            cssModules.set(normalize(id), code);
            return { code: 'export {};', moduleType: 'js' };
          },
        },
      },
    ],
    onLog(level, log, handler) {
      if (log.plugin === 'ecij') {
        if (log.id !== undefined) {
          log.id = normalize(log.id);
        }
        if (log.loc?.file !== undefined) {
          log.loc.file = normalize(log.loc.file);
        }
        logs.push(log);
      } else {
        handler(level, log);
      }
    },
  });

  try {
    const { output } = await bundle.generate({ format: 'es' });

    const jsChunk = output.find((chunk) => chunk.type === 'chunk');

    // `typedTone` must come from the `export *` value ('salmon'), not the
    // type-only decoy re-exports ('WRONG-decoy-value'), and the type-only
    // star source must not make the name ambiguous.
    expect(jsChunk?.code.trim()).toMatchInlineSnapshot(`
      "//#region test/fixtures/typed.input.ts
      const usesTypedTone = "css-ad8768ea";
      //#endregion
      export { usesTypedTone };"
    `);
    expect(cssModules).toMatchInlineSnapshot(`
      Map {
        "test/fixtures/typed.input.ts.90ad1b45.css" => ".css-ad8768ea {
        /* uses typed-tone */
        color: salmon;
        outline-color: plum;
        width: 12px;
        border-color: navy;
      }",
      }
    `);
    expect(logs).toMatchInlineSnapshot(`[]`);
  } finally {
    await bundle.close();
  }
});

test('mutually importing css modules resolve through the cycle', async () => {
  const fixturePath = './test/fixtures/cycle-a.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // cycle-a uses cycle-b's class and vice versa. Loading the in-flight module
  // is skipped (it would deadlock), but classes extracted so far are visible,
  // so both sides resolve.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/cycle-a.input.ts
    var aClass = "css-d4dd33b6";
    var usesB = "css-9a8fadf3";
    //#endregion
    export { aClass, usesB };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-6df9125c {
      /* cycle-b */
      &.css-d4dd33b6 {
        color: green;
      }
    }.css-d4dd33b6 {
      /* cycle-a */
      color: red;
    }

    .css-9a8fadf3 {
      &.css-6df9125c {
        color: blue;
      }
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('sibling modules transformed concurrently resolve each other’s classes', async () => {
  const fixturePath = './test/fixtures/siblings.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // The consumer resolves the producer's class while the producer may still
  // be mid-transform — the load must be awaited (no cycle), never skipped.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/siblings.input.ts
    var usesBoth = "css-fe2dd194";
    //#endregion
    export { usesBoth };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-1ad5d685 {
      /* producer */
      margin: 4px;
    }.css-e587a2cb {
      /* consumer */
      &.css-1ad5d685 {
        color: blue;
      }
    }.css-fe2dd194 {
      /* uses-both */
      &.css-1ad5d685 {
        color: red;
      }

      &.css-e587a2cb {
        color: green;
      }
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('same-file class references: forward references resolve, failed extractions warn', async () => {
  const fixturePath = './test/fixtures/same-file-classes.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // `usesForward` references a class declared later in the file (resolves via
  // deferred retry); `usesBrokenSameFile` references a class whose extraction
  // failed and must warn instead of inlining a phantom class.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/same-file-classes.input.ts
    function dynamicPad() {
    	return 4;
    }
    var usesForward = "css-8432a53b";
    var forwardClass = "css-af69c7f2";
    var usesBrokenSameFile = css\`
      &.\${css\`
      padding: \${dynamicPad()}px;
    \`} {
        color: red;
      }
    \`;
    //#endregion
    export { forwardClass, usesBrokenSameFile, usesForward };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-8432a53b {
      &.css-af69c7f2 {
        color: red;
      }
    }

    .css-af69c7f2 {
      /* forward */
      color: green;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "14: \`;
    15: const brokenSameFile = css\`
    16:   padding: \${dynamicPad()}px;
                     ^
    17: \`;
    18: export const usesBrokenSameFile = css\`",
        "hook": "transform",
        "id": "test/fixtures/same-file-classes.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/same-file-classes.input.ts",
          "line": 16,
        },
        "message": "skipped CSS extraction — interpolation is not a static string, number, or identifier",
        "plugin": "ecij",
        "pluginCode": "COMPLEX_INTERPOLATION",
        "pos": 291,
      },
      {
        "code": "PLUGIN_WARNING",
        "frame": "17: \`;
    18: export const usesBrokenSameFile = css\`
    19:   &.\${brokenSameFile} {
              ^
    20:     color: red;
    21:   }",
        "hook": "transform",
        "id": "test/fixtures/same-file-classes.input.ts",
        "loc": {
          "column": 6,
          "file": "test/fixtures/same-file-classes.input.ts",
          "line": 19,
        },
        "message": "skipped CSS extraction — could not resolve "brokenSameFile" to a static string or number",
        "plugin": "ecij",
        "pluginCode": "UNRESOLVED_INTERPOLATION",
        "pos": 356,
      },
    ]
  `);
});

test('failed `export *` probes do not drag their stylesheets in', async () => {
  const fixturePath = './test/fixtures/barrel-deep-only.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // Resolving `dColor` probes barrel-a/barrel-b without finding it — their
  // CSS (/* a */, /* b */) must not appear in the output.
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/barrel-deep-only.input.ts
    var usesOnlyDeep = "css-ec484d9a";
    //#endregion
    export { usesOnlyDeep };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-ec484d9a {
      /* uses-only-deep */
      color: darkcyan;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('hoisted local bindings declared after the template shadow the (aliased) css tag', async () => {
  const fixturePath = './test/fixtures/tag-shadow-hoisting.input.ts';
  const result = await buildWithPlugin(fixturePath);

  // The tag is imported as `import { css as styled }`. Only the two templates
  // whose tag is not shadowed are extracted; the others keep calling the local
  // binding they refer to at runtime
  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/tag-shadow-hoisting.input.ts
    function laterConst() {
    	const shadowed = styled\`
        color: red;
      \`;
    	const styled = String.raw;
    	return [shadowed, styled];
    }
    function laterVar() {
    	const shadowed = styled\`
        color: green;
      \`;
    	var styled = String.raw;
    	return [shadowed, styled];
    }
    function laterFunction() {
    	const shadowed = styled\`
        color: blue;
      \`;
    	function styled(strings) {
    		return strings.raw.join("");
    	}
    	return shadowed;
    }
    function laterClass() {
    	const shadowed = styled\`
        color: purple;
      \`;
    	class styled {}
    	return [shadowed, styled];
    }
    function selfReference() {
    	const styled = styled\`
        color: orange;
      \`;
    	return styled;
    }
    function enclosingScope() {
    	const inner = () => styled\`
        color: pink;
      \`;
    	const styled = String.raw;
    	return [inner(), styled];
    }
    function nestedBlock() {
    	const extracted = "css-3fbc0559";
    	{
    		const styled = String.raw;
    		console.log(styled\`nested\`);
    	}
    	return extracted;
    }
    var moduleLevel = "css-cc02a132";
    //#endregion
    export { enclosingScope, laterClass, laterConst, laterFunction, laterVar, moduleLevel, nestedBlock, selfReference };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".css-3fbc0559 {
      color: teal;
    }

    .css-cc02a132 {
      color: gold;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});

test('skipped declarations do not register stylesheet dependencies', async () => {
  const fixturePath = './test/fixtures/dependency-skipped.input.ts';
  const result = await buildWithPlugin(fixturePath);

  expect(result.js).toMatchInlineSnapshot(`
    "//#region index.js
    function css() {
    	throw new Error("css\`\` should have been transformed by the ecij plugin");
    }
    //#endregion
    //#region test/fixtures/dependency-skipped.input.ts
    var skipped = css\`
      &.\${"css-9cfab70f"} {
        width: \${Math.random()}px;
      }
    \`;
    var extracted = "css-93a3b18c";
    //#endregion
    export { extracted, skipped };"
  `);
  // The helper's stylesheet is only reached through the untouched import, so it
  // follows this module's own CSS instead of being hoisted above it as a dependency
  expect(result.css).toMatchInlineSnapshot(`
    ".css-93a3b18c {
      color: red;
    }.css-9cfab70f {
      /* accent */
      background: crimson;
      font-size: 14px;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`
    [
      {
        "code": "PLUGIN_WARNING",
        "frame": "3: export const skipped = css\`
    4:   &.\${accentClass} {
    5:     width: \${Math.random()}px;
                    ^
    6:   }
    7: \`;",
        "hook": "transform",
        "id": "test/fixtures/dependency-skipped.input.ts",
        "loc": {
          "column": 13,
          "file": "test/fixtures/dependency-skipped.input.ts",
          "line": 5,
        },
        "message": "skipped CSS extraction — interpolation is not a static string, number, or identifier",
        "plugin": "ecij",
        "pluginCode": "COMPLEX_INTERPOLATION",
        "pos": 136,
      },
    ]
  `);
});

test('classPrefix setting', async () => {
  const fixturePath = './test/fixtures/identical.input.ts';
  const result = await buildWithPlugin(fixturePath, {
    classPrefix: 'custom_',
  });

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/identical-first.ts
    var myClass = "custom_3f848070";
    //#endregion
    //#region test/fixtures/identical-second.ts
    var myClass$1 = "custom_5a57e4d1";
    //#endregion
    export { myClass as firstClass, myClass$1 as secondClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".custom_3f848070 {
      color: green;
    }.custom_5a57e4d1 {
      color: green;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});
