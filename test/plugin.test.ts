import { ecij, type Configuration } from 'ecij/plugin';
import type { RolldownLog } from 'rolldown';
import { build } from 'vite';
import { expect, test } from 'vitest';

const normalize = (path: string) => path.replace(/^.*\/test\//, 'test/');

// Helper to run a vite build with the ecij plugin
async function buildWithPlugin(entry: string, pluginOptions?: Configuration) {
  const logs: RolldownLog[] = [];

  const output = await build({
    build: {
      lib: {
        entry,
        formats: ['es'],
      },
      minify: false,
      write: false,
      rolldownOptions: {
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

  // Should only have JS and CSS outputs
  expect(chunks.length).toBeLessThanOrEqual(2);

  // Extract JS and CSS chunks
  const jsChunk = chunks.find((chunk) => chunk.type === 'chunk');
  const cssChunk = chunks.find((chunk) => chunk.type === 'asset');

  return {
    js: jsChunk?.code.trim(),
    css: (cssChunk?.source as string | undefined)?.trim(),
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
    ".css-3e6bfd87 {
      display: flex;
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
      color: teal;
      font-size: 20px;
    }

    .css-4d5166f1 {
      &.css-3e6bfd87 {
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
    var finalModuleCheck = "css-7ff6d232";
    //#endregion
    export { MyClass, afterClassExpr, arrayDestructuring, arrayRestShadow, arrowExprParam, arrowParamShadow, booleanLiteralShadow, catchShadow, classDeclShadow, classExprName, classExprNameInner, defaultParam, destructuredParam, finalModuleCheck, fnDeclShadow, fnExprName, fnExprNameInner, forInShadow, forOfDestructuring, forOfShadow, forStatementShadow, letNoInit, nonCssTaggedShadow, nonLiteralInit, objectDestructuring, objectRestShadow, paramPartialShadow, paramShadow, restParamShadow, switchScope, varForIn, varForOf, varInBlock };"
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

    .css-7ff6d232 {
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
    ]
  `);
});

test('classPrefix setting', async () => {
  const fixturePath = './test/fixtures/basic.input.ts';
  const result = await buildWithPlugin(fixturePath, {
    classPrefix: 'custom_',
  });

  expect(result.js).toMatchInlineSnapshot(`
    "//#region test/fixtures/basic.input.ts
    var basicClass = "custom_90f511d6";
    //#endregion
    export { basicClass };"
  `);
  expect(result.css).toMatchInlineSnapshot(`
    ".custom_90f511d6 {
      border: 1px solid blue;
      padding: 10px;
    }/*$vite$:1*/"
  `);
  expect(result.logs).toMatchInlineSnapshot(`[]`);
});
