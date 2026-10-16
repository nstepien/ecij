import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';

import type {
  BindingPattern,
  BlockStatement,
  ParamPattern,
  TaggedTemplateExpression,
} from '@oxc-project/types';
import { RolldownMagicString, type Plugin, type TransformPluginContext } from 'rolldown';
import { makeIdFiltersToMatchWithQuery } from 'rolldown/filter';
import { parseSync, Visitor } from 'rolldown/utils';
import type { Plugin as VitePlugin } from 'vite';

/**
 * Options for the {@link ecij} plugin.
 */
export interface Configuration {
  /**
   * Include patterns for files to process, matched against the module id.
   *
   * @default `/\.[cm]?[jt]sx?$/`
   */
  include?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Exclude patterns for files to skip, matched against the module id.
   *
   * @default `[/\/node_modules\//, /\.d\.ts$/]`
   */
  exclude?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Prefix for generated CSS class names.
   *
   * Should not be empty, as generated hashes may start with a digit, resulting in invalid CSS
   * class names.
   *
   * @default `'css-'`
   */
  classPrefix?: string | undefined | null;
}

interface Scope {
  /** `undefined` means "declared but value unknown at build time" (like function params). */
  identifiers: Map<string, string | undefined>;
  parent: Scope | null;
  /** `true` for function/module/static-block scopes (where `var` bindings land). */
  isFunctionScope: boolean;
}

interface Declaration {
  className: string;
  node: TaggedTemplateExpression;
  hasInterpolations: boolean;
  scope: Scope;
}

interface ParsedFileInfo {
  readonly declarations: readonly Declaration[];
  readonly importedIdentifiers: ReadonlyMap<string, { source: string; imported: string }>;
  readonly exportNameToValueMap: ReadonlyMap<string, string>;
}

// allow .js, .cjs, .mjs, .ts, .cts, .mts, .jsx, and .tsx files
const JS_TS_FILE_REGEX = /\.[cm]?[jt]sx?$/;

// disallow /node_modules/ and .d.ts files
const NODE_MODULES_REGEX = /\/node_modules\//;
const D_TS_FILE_REGEX = /\.d\.ts$/;

// match the generated stylesheet IDs, like /src/Button.tsx.1a2b3c4d.css
const STYLESHEET_ID_REGEX = /\.[0-9a-f]{8}\.css$/;

// Get the project root directory
const PROJECT_ROOT = cwd();

function hashText(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 8);
}

/**
 * Creates the plugin that extracts `css` tagged template literals into separate CSS files.
 *
 * The extracted CSS is emitted as virtual modules imported for their side effects, leaving
 * Rolldown, Vite, and any CSS plugins to process and bundle it.
 *
 * @param configuration Overrides for the file filters and the generated class name prefix.
 * @returns The Rolldown/Vite plugin.
 * @example
 * <caption>vite.config.ts</caption>
 * ```ts
 * import { defineConfig } from 'vite';
 * import { ecij } from 'ecij/plugin';
 *
 * export default defineConfig({
 *   plugins: [ecij()],
 * });
 * ```
 * @see [ecij documentation](https://github.com/nstepien/ecij#readme)
 */
export function ecij(configuration?: Configuration | null): Plugin {
  const include = configuration?.include ?? JS_TS_FILE_REGEX;
  const exclude = configuration?.exclude ?? [NODE_MODULES_REGEX, D_TS_FILE_REGEX];
  const classPrefix = configuration?.classPrefix ?? 'css-';

  const parsedFileInfoCache = new Map<string, ParsedFileInfo>();

  /**
   * Generated CSS module IDs for each source file, imported ahead of the stylesheet of any
   * module that interpolates its class names, to preserve the cascade order.
   *
   * Key: module id, Value: CSS module id
   */
  const stylesheetImportPerFile = new Map<string, string>();

  /**
   * Extracted CSS content per source file.
   *
   * Key: virtual module ID, Value: CSS content
   */
  const extractedCssPerFile = new Map<string, string>();

  /**
   * The modules whose CSS interpolates values exported by each module.
   *
   * Key: module id, Value: ids of the modules interpolating its values
   */
  const dependentsPerFile = new Map<string, Set<string>>();

  /**
   * The module that each running transform is waiting for through `this.load()`.
   *
   * Key: module id, Value: module id
   */
  const pendingLoads = new Map<string, string>();

  /**
   * Whether the transform of `moduleId` is waiting for `targetId`, directly or through the
   * transforms it is waiting for.
   */
  function isWaitingFor(moduleId: string, targetId: string): boolean {
    if (moduleId === targetId) {
      return true;
    }

    const awaitedId = pendingLoads.get(moduleId);

    return awaitedId !== undefined && isWaitingFor(awaitedId, targetId);
  }

  /**
   * Parses a file and extracts all relevant information in a single pass.
   */
  async function parseFile(
    context: TransformPluginContext,
    filePath: string,
    code?: string,
  ): Promise<ParsedFileInfo> {
    // The code loaded from `readFile` might not be identical
    // to the code passed in after it has been processed by other plugins;
    // as such, we cannot rely on the position of declarations being the same,
    // and the new code should be parsed.
    if (code === undefined && parsedFileInfoCache.has(filePath)) {
      return parsedFileInfoCache.get(filePath)!;
    }

    // Convert absolute path to project-relative path and normalize to Unix format
    // to ensure consistent hashes across different build environments (Windows/Unix)
    const relativePath = relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');

    // Read the source file
    const sourceText = code ?? (await context.fs.readFile(filePath, { encoding: 'utf8' }));

    const parseResult = parseSync(filePath, sourceText);
    const declarations: Declaration[] = [];
    const importedIdentifiers = new Map<string, { source: string; imported: string }>();
    const exportNameToValueMap = new Map<string, string>();
    const localNameToExportedNameMap = new Map<string, string>();
    const taggedTemplateExpressionFromVariableDeclarator = new Set<TaggedTemplateExpression>();
    let hasCSSTagImport = false;

    // Scope tracking: root scope for module-level declarations
    const rootScope: Scope = { identifiers: new Map(), parent: null, isFunctionScope: true };
    let currentScope = rootScope;
    let currentVariableDeclarationKind: string | undefined;

    const parsedInfo: ParsedFileInfo = {
      declarations,
      importedIdentifiers,
      exportNameToValueMap,
    };

    parsedFileInfoCache.set(filePath, parsedInfo);

    // Collect imports
    for (const staticImport of parseResult.module.staticImports) {
      for (const entry of staticImport.entries) {
        // TODO: support default and namespace imports
        if (entry.importName.kind === 'Name') {
          const source = staticImport.moduleRequest.value;
          const imported = entry.importName.name!;
          const localName = entry.localName.value;

          if (source === 'ecij' && imported === 'css' && localName === 'css') {
            hasCSSTagImport = true;
          }

          importedIdentifiers.set(localName, { source, imported });
        }
      }
    }

    // Collect exports
    for (const staticExport of parseResult.module.staticExports) {
      for (const entry of staticExport.entries) {
        // TODO: handle re-exports
        if (entry.importName.kind !== 'None') continue;

        // TODO: support default and namespace exports
        if (entry.exportName.kind === 'Name' && entry.localName.kind === 'Name') {
          const localName = entry.localName.name!;
          const exportedName = entry.exportName.name!;
          localNameToExportedNameMap.set(localName, exportedName);
        }
      }
    }

    function recordIdentifierWithValue(localName: string, value: string, scope = currentScope) {
      scope.identifiers.set(localName, value);

      // Only record exports for module-level (root scope) declarations
      if (scope === rootScope && localNameToExportedNameMap.has(localName)) {
        const exportedName = localNameToExportedNameMap.get(localName)!;
        exportNameToValueMap.set(exportedName, value);
      }
    }

    function handleTaggedTemplateExpression(
      localName: string | undefined,
      node: TaggedTemplateExpression,
      scope = currentScope,
    ) {
      if (!(hasCSSTagImport && node.tag.type === 'Identifier' && node.tag.name === 'css')) {
        return;
      }

      const index = declarations.length;

      // Create a hash from the relative file path, index,
      // and identifier for consistency across builds.
      // The index is always used to avoid collisions with other variables
      // with the same name in the same file.
      const hash = hashText(`${relativePath}:${index}:${localName}`);

      const className = `${classPrefix}${hash}`;

      declarations.push({
        className,
        node,
        hasInterpolations: node.quasi.expressions.length !== 0,
        scope,
      });

      // Record generated class names for css declarations
      if (localName !== undefined) {
        recordIdentifierWithValue(localName, className, scope);
      }
    }

    function pushScope(isFunctionScope = false) {
      currentScope = { identifiers: new Map(), parent: currentScope, isFunctionScope };
    }

    function findFunctionScope(): Scope {
      let scope = currentScope;
      while (!scope.isFunctionScope) {
        scope = scope.parent!;
      }
      return scope;
    }

    function popScope() {
      currentScope = currentScope.parent!;
    }

    // When a parent node (function, for-statement, catch) already creates a scope,
    // the child BlockStatement should reuse it instead of creating a redundant nested scope.
    const skippedBlockStatements = new Set<BlockStatement>();

    // Recursively extract all binding identifiers from a pattern and record them
    // as unknown values in the current scope (for shadowing).
    function recordBindingPattern(pattern: BindingPattern, scope = currentScope) {
      switch (pattern.type) {
        case 'Identifier':
          scope.identifiers.set(pattern.name, undefined);
          break;
        case 'ObjectPattern':
          for (const prop of pattern.properties) {
            if (prop.type === 'RestElement') {
              recordBindingPattern(prop.argument, scope);
            } else {
              recordBindingPattern(prop.value, scope);
            }
          }
          break;
        case 'ArrayPattern':
          for (const element of pattern.elements) {
            if (element === null) continue;
            if (element.type === 'RestElement') {
              recordBindingPattern(element.argument, scope);
            } else {
              recordBindingPattern(element, scope);
            }
          }
          break;
        case 'AssignmentPattern':
          recordBindingPattern(pattern.left, scope);
          break;
      }
    }

    function recordParams(params: ParamPattern[]) {
      for (const param of params) {
        if (param.type === 'TSParameterProperty') {
          recordBindingPattern(param.parameter);
        } else if (param.type === 'RestElement') {
          // Rest parameter: function foo(...args)
          recordBindingPattern(param.argument);
        } else {
          // FormalParameter extends BindingPattern
          recordBindingPattern(param);
        }
      }
    }

    // Visit AST to collect declarations and literal values
    const visitor = new Visitor({
      BlockStatement(node) {
        if (!skippedBlockStatements.has(node)) {
          pushScope();
        }
      },

      'BlockStatement:exit'(node) {
        if (!skippedBlockStatements.has(node)) {
          popScope();
        }
      },

      // Functions: create a scope for parameters and merge with the body's BlockStatement.
      // FunctionDeclaration names are bound in the containing scope (before pushScope).
      FunctionDeclaration(node) {
        if (node.id !== null) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
        pushScope(true);
        recordParams(node.params);
        if (node.body?.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'FunctionDeclaration:exit': popScope,

      // FunctionExpression names are only visible inside the function body (for recursion).
      FunctionExpression(node) {
        pushScope(true);
        if (node.id !== null) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
        recordParams(node.params);
        if (node.body?.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'FunctionExpression:exit': popScope,

      ArrowFunctionExpression(node) {
        pushScope(true);
        recordParams(node.params);
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ArrowFunctionExpression:exit': popScope,

      // For statements: create a scope for loop variable declarations
      // and merge with the body's BlockStatement
      ForStatement(node) {
        pushScope();
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ForStatement:exit': popScope,

      ForInStatement(node) {
        pushScope();
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ForInStatement:exit': popScope,

      ForOfStatement(node) {
        pushScope();
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ForOfStatement:exit': popScope,

      // Switch statements create a scope for case-level declarations.
      // SwitchCase consequent is Array<Statement>, not a BlockStatement, so no merge is needed.
      SwitchStatement() {
        pushScope();
      },
      'SwitchStatement:exit': popScope,

      // Catch clauses: create a scope for the catch parameter and merge with the body's BlockStatement
      CatchClause(node) {
        pushScope();
        if (node.param !== null) {
          recordBindingPattern(node.param);
        }
        skippedBlockStatements.add(node.body);
      },
      'CatchClause:exit': popScope,

      // Class declaration names are bound in the containing scope (like function declarations).
      ClassDeclaration(node) {
        if (node.id !== null) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
      },

      // Class expression names are only visible inside the class body (like FunctionExpression).
      ClassExpression(node) {
        pushScope();
        if (node.id !== null) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
      },
      'ClassExpression:exit': popScope,

      // Static blocks have their own scope (type is "StaticBlock", not "BlockStatement").
      // They are function-scoped for `var` declarations.
      StaticBlock() {
        pushScope(true);
      },
      'StaticBlock:exit': popScope,

      VariableDeclaration(node) {
        currentVariableDeclarationKind = node.kind;
      },
      'VariableDeclaration:exit'() {
        currentVariableDeclarationKind = undefined;
      },

      VariableDeclarator(node) {
        // `var` declarations are function-scoped; `let`/`const` are block-scoped
        const targetScope =
          currentVariableDeclarationKind === 'var' ? findFunctionScope() : currentScope;

        if (node.id.type !== 'Identifier') {
          // Destructuring pattern: record all binding identifiers for shadowing
          recordBindingPattern(node.id, targetScope);
          return;
        }

        const localName = node.id.name;

        switch (node.init?.type) {
          case 'TaggedTemplateExpression':
            if (node.init.tag.type === 'Identifier' && node.init.tag.name === 'css') {
              taggedTemplateExpressionFromVariableDeclarator.add(node.init);
              handleTaggedTemplateExpression(localName, node.init, targetScope);
              return;
            }
            break;

          case 'Literal':
            if (typeof node.init.value === 'string' || typeof node.init.value === 'number') {
              const value = String(node.init.value);
              recordIdentifierWithValue(localName, value, targetScope);
              return;
            }
            break;
        }

        // Record as unknown value so it shadows outer variables
        targetScope.identifiers.set(localName, undefined);
      },

      TaggedTemplateExpression(node) {
        if (!taggedTemplateExpressionFromVariableDeclarator.has(node)) {
          // No variable name for inline expressions
          handleTaggedTemplateExpression(undefined, node);
        }
      },
    });

    visitor.visit(parseResult.program);

    return parsedInfo;
  }

  /**
   * Extracts CSS from template literals in the source code using AST parsing.
   *
   * Supports interpolations of strings and numbers, both local and imported.
   */
  async function extractCssFromCode(
    context: TransformPluginContext,
    code: string,
    filePath: string,
    meta: { magicString?: RolldownMagicString },
  ): Promise<{
    magicString: RolldownMagicString | null;
    cssContent: string;
    stylesheetDependencies: Set<string>;
  }> {
    const { declarations, importedIdentifiers } = await parseFile(context, filePath, code);

    const cssExtractions: Array<{
      className: string;
      cssContent: string;
      sourcePosition: number;
    }> = [];
    const replacements: Array<{
      start: number;
      end: number;
      className: string;
    }> = [];
    const stylesheetDependencies = new Set<string>();

    // Helper to resolve a value from an identifier, walking up the scope chain
    async function resolveValue(identifierName: string, scope: Scope): Promise<string | undefined> {
      if (scope.identifiers.has(identifierName)) {
        // May return undefined for declarations with unknown values (like function params),
        // which stops the lookup and signals "can't resolve"
        return scope.identifiers.get(identifierName);
      }

      // Walk up the scope chain to find the identifier
      const { parent } = scope;
      if (parent !== null) {
        return resolveValue(identifierName, parent);
      }

      // Check if it's an imported identifier
      if (importedIdentifiers.has(identifierName)) {
        const { source, imported } = importedIdentifiers.get(identifierName)!;

        // Resolve the import path relative to the importer
        const resolvedId = await context.resolve(source, filePath);

        if (resolvedId != null) {
          const { id } = resolvedId;

          // Record the dependency so that editing the imported module updates this one
          let dependents = dependentsPerFile.get(id);

          if (dependents === undefined) {
            dependents = new Set();
            dependentsPerFile.set(id, dependents);
          }

          dependents.add(filePath);

          // Wait for the imported module's transform, which registers the stylesheet imported
          // below. Vite's dev server does not transform modules loaded this way, so there the
          // stylesheet is only imported once that module has been transformed.
          // Loading a module whose transform waits for this one would never finish, which
          // happens when modules interpolate each other's class names. Its stylesheet is then
          // not registered yet, but values come from the module's parse either way.
          if (!isWaitingFor(id, filePath)) {
            pendingLoads.set(filePath, id);

            try {
              await context.load(resolvedId);
            } finally {
              pendingLoads.delete(filePath);
            }
          }

          const { exportNameToValueMap } = await parseFile(context, id);

          if (exportNameToValueMap.has(imported)) {
            if (stylesheetImportPerFile.has(id)) {
              stylesheetDependencies.add(stylesheetImportPerFile.get(id)!);
            }
            return exportNameToValueMap.get(imported)!;
          }
        }
      }

      return;
    }

    // Helper to add a processed CSS declaration
    function addProcessedDeclaration(declaration: Declaration, cssContent: string) {
      const { className, node } = declaration;

      cssExtractions.push({
        className,
        cssContent: cssContent.trim(),
        sourcePosition: node.start,
      });

      replacements.push({
        start: node.start,
        end: node.end,
        className,
      });
    }

    // Process declarations in two passes
    // Pass 1: No interpolations
    for (const declaration of declarations) {
      if (declaration.hasInterpolations) continue;

      const cssContent = declaration.node.quasi.quasis[0]!.value.raw;
      addProcessedDeclaration(declaration, cssContent);
    }

    // Pass 2: With interpolations using resolved local references
    for (const declaration of declarations) {
      if (!declaration.hasInterpolations) continue;

      const { quasis, expressions } = declaration.node.quasi;

      let cssContent = '';
      let allResolved = true;

      for (let i = 0; i < quasis.length; i++) {
        cssContent += quasis[i]!.value.raw;

        if (i < expressions.length) {
          const expression = expressions[i]!;

          let resolvedValue: string | undefined;

          if (
            expression.type === 'Literal' &&
            (typeof expression.value === 'string' || typeof expression.value === 'number')
          ) {
            resolvedValue = String(expression.value);
          } else if (
            expression.type === 'UnaryExpression' &&
            (expression.operator === '-' || expression.operator === '+') &&
            expression.argument.type === 'Literal' &&
            typeof expression.argument.value === 'number'
          ) {
            resolvedValue = String(
              expression.operator === '-' ? -expression.argument.value : expression.argument.value,
            );
          } else if (expression.type === 'Identifier') {
            resolvedValue = await resolveValue(expression.name, declaration.scope);

            if (resolvedValue === undefined) {
              // Cannot resolve - skip this entire css`` block
              context.warn(
                {
                  pluginCode: 'UNRESOLVED_INTERPOLATION',
                  message: `skipped CSS extraction — could not resolve "${expression.name}" to a static string or number`,
                },
                expression.start,
              );
              allResolved = false;
              break;
            }
          } else {
            // Complex expression - skip this entire css`` block
            context.warn(
              {
                pluginCode: 'COMPLEX_INTERPOLATION',
                message:
                  'skipped CSS extraction — interpolation is not a static string, number, or identifier',
              },
              expression.start,
            );
            allResolved = false;
            break;
          }

          cssContent += resolvedValue;
        }
      }

      // Only process if all interpolations were resolved
      if (allResolved) {
        addProcessedDeclaration(declaration, cssContent);
      }
    }

    if (replacements.length === 0) {
      return {
        magicString: null,
        cssContent: '',
        stylesheetDependencies,
      };
    }

    // Apply replacements through a magic string,
    // so an accurate sourcemap can be generated for the edits
    const magicString = meta.magicString ?? new RolldownMagicString(code);

    // Emit each class name as an IIFE instead of a literal to prevent issues with tree-shaking
    // (see inlineConst tests): `optimization.inlineConst` inlines string and template literal
    // constants, and once all used exports of a `sideEffects: false` module are inlined, the
    // module is dropped along with its stylesheet import. Rolldown does not evaluate calls as
    // constants, yet still treats the IIFE as side-effect-free, and minifiers fold it back to a
    // plain string. Do not annotate it with `@__PURE__`: terser does not inline annotated IIFEs.
    // Related upstream issues (Vite's own CSS Modules lose their CSS the same way):
    // https://github.com/vitejs/vite/issues/22344
    // https://github.com/rolldown/rolldown/issues/8100
    for (const { start, end, className } of replacements) {
      magicString.overwrite(start, end, `(() => ${JSON.stringify(className)})()`);
    }

    // Sort CSS extractions by source position to maintain original order
    cssExtractions.sort((a, b) => a.sourcePosition - b.sourcePosition);

    // Generate CSS module content
    const cssBlocks = [];

    for (const { className, cssContent } of cssExtractions) {
      if (cssContent !== '') {
        cssBlocks.push(`.${className} {\n  ${cssContent}\n}`);
      }
    }

    const cssContent = cssBlocks.join('\n\n');

    return {
      magicString,
      cssContent,
      stylesheetDependencies,
    };
  }

  // Rolldown's plugin type does not include Vite's hooks, which Rolldown ignores
  const plugin: Plugin & Pick<VitePlugin, 'hotUpdate'> = {
    name: 'ecij',

    buildEnd() {
      // Clear caches between builds (`pendingLoads` empties itself as each load settles)
      parsedFileInfoCache.clear();
      stylesheetImportPerFile.clear();
      extractedCssPerFile.clear();
      dependentsPerFile.clear();
    },

    watchChange(id) {
      // The dev server keeps the caches until it closes. Forget the parse of the edited module
      // and the stylesheets that change with it: its own, and those of the modules that
      // interpolate its values. Keep their CSS, as cached transforms may still import it.
      parsedFileInfoCache.delete(id);
      stylesheetImportPerFile.delete(id);

      for (const dependentId of dependentsPerFile.get(id) ?? []) {
        stylesheetImportPerFile.delete(dependentId);
      }
    },

    hotUpdate({ file, modules }) {
      // Vite reuses the transforms of the modules that import an edited module, only updating
      // their imports. Update the modules that interpolate its values as if they were edited,
      // as they import its stylesheet and their CSS may change, and the modules that interpolate
      // their class names, as they import their stylesheets.
      const updatedModules = new Set(modules);

      for (const dependentId of dependentsPerFile.get(file) ?? []) {
        for (const id of [dependentId, ...(dependentsPerFile.get(dependentId) ?? [])]) {
          for (const moduleNode of this.environment.moduleGraph.getModulesByFile(id) ?? []) {
            updatedModules.add(moduleNode);
          }
        }
      }

      return [...updatedModules];
    },

    resolveId: {
      filter: { id: STYLESHEET_ID_REGEX },
      handler(id) {
        // Claim the generated stylesheet IDs. They look like file paths but do not exist on
        // disk, so without this they would fail to resolve before `load` ever sees them.
        return extractedCssPerFile.has(id) ? id : null;
      },
    },

    load: {
      filter: { id: STYLESHEET_ID_REGEX },
      handler(id) {
        // Return the CSS content for extracted CSS modules
        return extractedCssPerFile.get(id) ?? null;
      },
    },

    transform: {
      filter: {
        id: {
          include: makeIdFiltersToMatchWithQuery(include),
          exclude: makeIdFiltersToMatchWithQuery(exclude),
        },
        // Skip files that do not reference 'ecij' before the handler is called
        code: 'ecij',
      },
      async handler(code, id, meta) {
        // Remove query parameters from the ID
        const queryIndex = id.indexOf('?');
        const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);

        // Extract CSS from the code
        const { magicString, cssContent, stylesheetDependencies } = await extractCssFromCode(
          this,
          code,
          cleanId,
          meta,
        );

        if (magicString === null) {
          return null;
        }

        // Avoid outputting empty CSS modules
        if (cssContent !== '') {
          // Generate CSS module ID for this file
          // A hash of the CSS content is created to make HMR work
          // Use the original file path with a .css extension
          // For example, /src/components/Button.tsx -> /src/components/Button.tsx.hash.css
          const hash = hashText(cssContent);
          const cssModuleId = `${cleanId}.${hash}.css`;

          // Store the CSS extractions for this file
          extractedCssPerFile.set(cssModuleId, cssContent);
          stylesheetImportPerFile.set(id, cssModuleId);

          const importStatements: string[] = [];

          // Import the stylesheets of the modules whose class names were interpolated into
          // the CSS above, ahead of this module's own. These statements are prepended to the
          // file, so leaving them out would emit this module's CSS before the CSS it
          // references, inverting the cascade.
          for (const id of stylesheetDependencies) {
            importStatements.push(`import ${JSON.stringify(id)};\n`);
          }

          // use JSON.stringify to properly escape the module ID,
          // including \ delimiters on Windows.
          importStatements.push(`import ${JSON.stringify(cssModuleId)};\n`);

          // Add side-effect/CSS module imports at the top of the file.
          magicString.prepend(importStatements.join(''));
        }

        // Rolldown provides a magic string and generates the sourcemap natively. Vite does not
        // forward it to plugins, in build or dev, so every Vite user goes through the fallback.
        if (meta.magicString) {
          return { code: meta.magicString };
        }

        return {
          code: magicString.toString(),
          map: magicString.generateMap({ hires: 'boundary' }).toString(),
        };
      },
    },
  };

  return plugin;
}
