import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';

import type {
  BindingPattern,
  BlockStatement,
  Expression,
  ParamPattern,
  SwitchCase,
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
  /**
   * The initializer of each `const`, resolved on demand, or `undefined` for the bindings whose value
   * is unknown at build time (like function params).
   */
  identifiers: Map<string, Expression | undefined>;
  parent: Scope | null;
  /** `true` for function/module/static-block scopes (where `var` bindings land). */
  isFunctionScope: boolean;
}

interface Declaration {
  className: string;
  /** Scope the template appears in, where its interpolations are resolved. */
  scope: Scope;
}

/**
 * A tagged template found while visiting a file. Whether its tag is ecij's `css` is only decided
 * once the visit completes and every scope is fully populated.
 */
interface CssTagCandidate {
  /** Name of the variable the template is assigned to, if any. */
  name: string | undefined;
  /** Scope the template appears in, where the tag and the interpolations are resolved. */
  scope: Scope;
}

interface ParsedFileInfo {
  /** Module id the file was parsed for, which its imports are resolved from. */
  readonly filePath: string;
  /** The css`` templates to extract in source order, keyed by template. */
  readonly declarations: ReadonlyMap<TaggedTemplateExpression, Declaration>;
  readonly importedIdentifiers: ReadonlyMap<string, { source: string; imported: string }>;
  /** Local names of the exported bindings, keyed by exported name. */
  readonly exportedLocalNames: ReadonlyMap<string, string>;
  /** Module-level scope, where the exported bindings are declared. */
  readonly rootScope: Scope;
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

// The innermost scope of the chain that binds `name`, shadowing outer bindings and imports.
function findBindingScope(name: string, scope: Scope): Scope | undefined {
  for (let current: Scope | null = scope; current !== null; current = current.parent) {
    if (current.identifiers.has(name)) return current;
  }
  return;
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
    const declarations = new Map<TaggedTemplateExpression, Declaration>();
    const importedIdentifiers = new Map<string, { source: string; imported: string }>();
    const exportedLocalNames = new Map<string, string>();
    // Local bindings of `css` imported from 'ecij' (including aliases)
    const cssTagNames = new Set<string>();

    // Scope tracking: root scope for module-level declarations
    const rootScope: Scope = { identifiers: new Map(), parent: null, isFunctionScope: true };
    let currentScope = rootScope;
    // Kinds of the `VariableDeclaration`s being visited, innermost last. An
    // initializer can itself contain declarations, like a function body, so a
    // single slot would be clobbered before the next declarator is visited.
    const variableDeclarationKinds: string[] = [];

    const parsedInfo: ParsedFileInfo = {
      filePath,
      declarations,
      importedIdentifiers,
      exportedLocalNames,
      rootScope,
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

          if (source === 'ecij' && imported === 'css') {
            cssTagNames.add(localName);
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
          exportedLocalNames.set(entry.exportName.name!, entry.localName.name!);
        }
      }
    }

    // Tagged templates in source order, keyed by template. Whether a tag is
    // ecij's `css` can only be decided when every scope is fully populated:
    // `let`/`const`/`class` declarations are hoisted to the top of their block
    // (TDZ) and `var`/function declarations to their function scope, so a
    // binding declared *after* the template still shadows the import at the
    // template's position.
    const cssTagCandidates = new Map<TaggedTemplateExpression, CssTagCandidate>();

    function addCssTagCandidate(node: TaggedTemplateExpression, name?: string) {
      cssTagCandidates.set(node, { name, scope: currentScope });
    }

    function extractCssTagCandidate(
      node: TaggedTemplateExpression,
      { name, scope }: CssTagCandidate,
    ) {
      // Skip other tags, including local bindings shadowing the imported one
      if (
        node.tag.type !== 'Identifier' ||
        !cssTagNames.has(node.tag.name) ||
        findBindingScope(node.tag.name, scope) !== undefined
      ) {
        return;
      }

      const index = declarations.size;

      // Create a hash from the relative file path, index,
      // and name for consistency across builds.
      // The index is always used to avoid collisions with other templates
      // with the same name, or lack thereof, in the same file.
      const hash = hashText(`${relativePath}:${index}:${name}`);

      const className = `${classPrefix}${hash}`;

      declarations.set(node, { className, scope });
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

    // Function bodies are function scopes of their own, see `BlockStatement`
    const functionBodies = new Set<BlockStatement>();
    // The switch scope is entered with the first case, see `SwitchStatement`
    const firstSwitchCases = new Set<SwitchCase>();

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
        // A function body is where its `var` declarations hoist to. Parameter
        // defaults are evaluated in the enclosing parameter scope and cannot
        // see the body's declarations.
        pushScope(functionBodies.has(node));
      },
      'BlockStatement:exit': popScope,

      // Functions: a scope for the parameters; the body block is a function
      // scope of its own (see `BlockStatement`), so `var` declarations hoist
      // into the body and parameter defaults cannot see the body's declarations.
      // FunctionDeclaration names are bound in the containing scope (before pushScope).
      FunctionDeclaration(node) {
        if (node.id !== null) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
        pushScope(true);
        recordParams(node.params);
        if (node.body?.type === 'BlockStatement') {
          functionBodies.add(node.body);
        }
      },
      'FunctionDeclaration:exit': popScope,

      // FunctionExpression names are only visible inside the function body (for recursion).
      // Methods, getters, setters, and constructors are function expressions too.
      FunctionExpression(node) {
        pushScope(true);
        if (node.id !== null) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
        recordParams(node.params);
        if (node.body?.type === 'BlockStatement') {
          functionBodies.add(node.body);
        }
      },
      'FunctionExpression:exit': popScope,

      ArrowFunctionExpression(node) {
        pushScope(true);
        recordParams(node.params);
        if (node.body.type === 'BlockStatement') {
          functionBodies.add(node.body);
        }
      },
      'ArrowFunctionExpression:exit': popScope,

      // Loops: a scope for the head's declarations; the body block keeps its
      // own nested scope (a body-level declaration may shadow a loop variable).
      ForStatement() {
        pushScope();
      },
      'ForStatement:exit': popScope,

      ForInStatement() {
        pushScope();
      },
      'ForInStatement:exit': popScope,

      ForOfStatement() {
        pushScope();
      },
      'ForOfStatement:exit': popScope,

      // Switch statements: a scope for case-level declarations, entered with
      // the first case so the discriminant is visited in the enclosing scope.
      SwitchStatement(node) {
        if (node.cases.length !== 0) {
          firstSwitchCases.add(node.cases[0]!);
        }
      },
      SwitchCase(node) {
        if (firstSwitchCases.has(node)) {
          pushScope();
        }
      },
      'SwitchStatement:exit'(node) {
        if (node.cases.length !== 0) {
          popScope();
        }
      },

      // Catch clauses: a scope for the parameter; the body block keeps its own
      // nested scope, like loop bodies.
      CatchClause(node) {
        pushScope();
        if (node.param !== null) {
          recordBindingPattern(node.param);
        }
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
        variableDeclarationKinds.push(node.kind);
      },
      'VariableDeclaration:exit'() {
        variableDeclarationKinds.pop();
      },

      VariableDeclarator(node) {
        // `var` declarations are function-scoped; `let`/`const` are block-scoped
        const targetScope =
          variableDeclarationKinds.at(-1) === 'var' ? findFunctionScope() : currentScope;

        if (node.id.type !== 'Identifier') {
          // Destructuring pattern: record all binding identifiers for shadowing
          recordBindingPattern(node.id, targetScope);
          return;
        }

        const localName = node.id.name;
        // Only a `const` has a static value: a `let`/`var` may be reassigned,
        // and a `var` is `undefined` until its declaration has run.
        const isConst = variableDeclarationKinds.at(-1) === 'const';

        // Record the initializer of a `const`, resolved on demand, or an unknown
        // value: either way, the binding shadows outer variables
        targetScope.identifiers.set(
          localName,
          isConst && node.init !== null ? node.init : undefined,
        );

        if (node.init?.type === 'TaggedTemplateExpression') {
          addCssTagCandidate(node.init, localName);
        }
      },

      TaggedTemplateExpression(node) {
        // Declarators add their templates first, with the variable name
        if (!cssTagCandidates.has(node)) {
          // No variable name for inline expressions
          addCssTagCandidate(node);
        }
      },
    });

    visitor.visit(parseResult.program);

    // Every scope is populated now, so tag shadowing can be decided
    for (const [node, candidate] of cssTagCandidates) {
      extractCssTagCandidate(node, candidate);
    }

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
    const parsedInfo = await parseFile(context, filePath, code);
    const { declarations } = parsedInfo;

    const extractions: Array<{
      start: number;
      end: number;
      className: string;
      cssContent: string;
    }> = [];
    const stylesheetDependencies = new Set<string>();

    // Values of the `const` bindings resolved so far, unknown ones included, keyed by initializer.
    // A binding is cached as unknown while it is resolved, so that a cycle stays unknown. The cache
    // is not shared with other transforms, as values read through imports can change in between.
    const constValues = new Map<Expression, string | undefined>();

    // Statically evaluates an expression of a file, like an interpolation or the initializer of a
    // `const`, to its string value: a string or number literal, including signed numbers (`-5`,
    // `+5`), or an identifier bound to such a value or to a class name, in the file or imported
    async function resolveValue(
      expression: Expression,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
      if (
        expression.type === 'Literal' &&
        (typeof expression.value === 'string' || typeof expression.value === 'number')
      ) {
        return String(expression.value);
      }

      if (
        expression.type === 'UnaryExpression' &&
        (expression.operator === '-' || expression.operator === '+') &&
        expression.argument.type === 'Literal' &&
        typeof expression.argument.value === 'number'
      ) {
        return String(
          expression.operator === '-' ? -expression.argument.value : expression.argument.value,
        );
      }

      if (expression.type !== 'Identifier') {
        return;
      }

      // Walk up the scope chain to find the identifier
      const bindingScope = findBindingScope(expression.name, scope);

      if (bindingScope !== undefined) {
        return resolveBinding(expression.name, bindingScope, fileInfo);
      }

      // Check if it's an imported identifier
      if (fileInfo.importedIdentifiers.has(expression.name)) {
        const { source, imported } = fileInfo.importedIdentifiers.get(expression.name)!;

        // Resolve the import path relative to the importer
        const resolvedId = await context.resolve(source, fileInfo.filePath);

        if (resolvedId != null) {
          const { id } = resolvedId;

          // Record the dependency so that editing the imported module updates the transformed one
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

          const importedFileInfo = await parseFile(context, id);
          const localName = importedFileInfo.exportedLocalNames.get(imported);

          // Only bindings declared in the module are resolved, not the imports it exports
          if (localName !== undefined) {
            const value = await resolveBinding(
              localName,
              importedFileInfo.rootScope,
              importedFileInfo,
            );

            if (value !== undefined) {
              if (stylesheetImportPerFile.has(id)) {
                stylesheetDependencies.add(stylesheetImportPerFile.get(id)!);
              }
              return value;
            }
          }
        }
      }

      return;
    }

    // Resolves the binding `name` declared in `scope`: a `const` takes the class name of its css``
    // template or the value of its initializer. Other bindings have unknown values (like function
    // params), which stops the lookup and signals "can't resolve".
    async function resolveBinding(
      name: string,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
      const init = scope.identifiers.get(name);

      if (init === undefined) {
        return;
      }

      if (init.type === 'TaggedTemplateExpression') {
        // Templates whose tag is not ecij's `css` have no class name
        return fileInfo.declarations.get(init)?.className;
      }

      if (!constValues.has(init)) {
        constValues.set(init, undefined);
        constValues.set(init, await resolveValue(init, scope, fileInfo));
      }

      return constValues.get(init);
    }

    // Build the CSS of each template, resolving its interpolations
    for (const [node, { className, scope }] of declarations) {
      const { quasis, expressions } = node.quasi;

      let cssContent = '';
      let allResolved = true;

      for (let i = 0; i < quasis.length; i++) {
        cssContent += quasis[i]!.value.raw;

        if (i < expressions.length) {
          const expression = expressions[i]!;

          const resolvedValue = await resolveValue(expression, scope, parsedInfo);

          if (resolvedValue === undefined) {
            if (expression.type === 'Identifier') {
              // Cannot resolve - skip this entire css`` block
              context.warn(
                {
                  pluginCode: 'UNRESOLVED_INTERPOLATION',
                  message: `skipped CSS extraction — could not resolve "${expression.name}" to a static string or number`,
                },
                expression.start,
              );
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
            }

            allResolved = false;
            break;
          }

          cssContent += resolvedValue;
        }
      }

      // Only extract the template if all its interpolations were resolved
      if (allResolved) {
        extractions.push({
          start: node.start,
          end: node.end,
          className,
          cssContent: cssContent.trim(),
        });
      }
    }

    if (extractions.length === 0) {
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
    for (const { start, end, className } of extractions) {
      magicString.overwrite(start, end, `(() => ${JSON.stringify(className)})()`);
    }

    // Generate CSS module content, in the source order of the declarations
    const cssBlocks = [];

    for (const { className, cssContent } of extractions) {
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
