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
  TSModuleDeclaration,
  TSTypeName,
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
  node: TaggedTemplateExpression;
  /** Scope the template appears in, where its interpolations are resolved. */
  scope: Scope;
}

/**
 * A css`` template found while visiting a file. Whether its tag is shadowed is only decided once
 * the visit completes and every scope is fully populated.
 */
interface CssTagCandidate {
  /** Variable the template is assigned to, if any, or `default` for an `export default`. */
  localName: string | undefined;
  node: TaggedTemplateExpression;
  /** Local name of the tag, a binding of ecij's `css`. */
  tagName: string;
  /** Scope the template appears in, where the tag and the interpolations are resolved. */
  scope: Scope;
}

type ImportedIdentifier =
  // `import { x } from 'mod'`, and `import x from 'mod'`, which imports `default`
  | { kind: 'named'; source: string; imported: string }
  // `import * as ns from 'mod'`
  | { kind: 'namespace'; source: string };

type ModuleExport =
  // `export { x }` and `export const x = …`: a binding declared in the module
  | { kind: 'local'; localName: string }
  // `export default <expression>`, which exports the value of the expression where it appears
  | { kind: 'default'; expression: Expression }
  // `export { x } from 'mod'`, and the export of a binding imported from 'mod'
  | { kind: 'reexport'; source: string; imported: string }
  // `export * as ns from 'mod'`, and the export of `import * as ns from 'mod'`
  | { kind: 'namespace'; source: string };

interface ParsedFileInfo {
  /** Module id the file was parsed for, which its imports are resolved from. */
  readonly filePath: string;
  /** The css`` templates to extract in source order, keyed by template. */
  readonly declarations: ReadonlyMap<TaggedTemplateExpression, Declaration>;
  /** Where the stylesheet imports go: after the hashbang and the directive prologue. */
  readonly importInsertionPosition: number;
  readonly importedIdentifiers: ReadonlyMap<string, ImportedIdentifier>;
  /** The exports of the module, keyed by exported name, except those of `export *`. */
  readonly moduleExports: ReadonlyMap<string, ModuleExport>;
  /** Sources of `export * from 'mod'`, which provide the other names, except `default`. */
  readonly exportStarSources: readonly string[];
  /** Module-level scope, where the exported bindings are declared. */
  readonly rootScope: Scope;
}

// Languages the parser can be told to parse a module as, see `meta.moduleType`
type ParseLang = 'js' | 'jsx' | 'ts' | 'tsx';

// allow .js, .cjs, .mjs, .ts, .cts, .mts, .jsx, and .tsx files
const JS_TS_FILE_REGEX = /\.[cm]?[jt]sx?$/;

// disallow /node_modules/ and .d.ts files
const NODE_MODULES_REGEX = /\/node_modules\//;
const D_TS_FILE_REGEX = /\.d\.ts$/;

// match the generated stylesheet IDs, like /src/Button.tsx.1a2b3c4d.css
const STYLESHEET_ID_REGEX = /\.[0-9a-f]{8}\.css$/;

// Queries Vite appends to the ids of the modules it serves without changing their code, like
// cache busting. Any other query denotes a module with code of its own, like `?raw` (the text of
// the file), `?url` (its URL), or `?html-proxy` (an inline script of an HTML page).
const TRANSPARENT_QUERY_KEYS = new Set(['v', 't', 'import', 'direct', 'used']);

const PARSE_LANGS: ReadonlySet<string> = new Set<ParseLang>(['js', 'jsx', 'ts', 'tsx']);

// Get the project root directory
const PROJECT_ROOT = cwd();

function hashText(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 8);
}

// Removes the query of a module id, like `/src/a.ts?raw` -> `/src/a.ts`
function stripQuery(id: string): string {
  const queryIndex = id.indexOf('?');
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

// The identity of a module, under which its parse and stylesheet are kept: its id, without the
// queries that do not change its code
function moduleKey(id: string): string {
  const queryIndex = id.indexOf('?');

  if (queryIndex !== -1) {
    for (const key of new URLSearchParams(id.slice(queryIndex + 1)).keys()) {
      if (!TRANSPARENT_QUERY_KEYS.has(key)) return id;
    }
  }

  return stripQuery(id);
}

function parseLangOf(moduleType: string | undefined): ParseLang | undefined {
  return moduleType !== undefined && PARSE_LANGS.has(moduleType)
    ? (moduleType as ParseLang)
    : undefined;
}

// Vite attaches its environment to plugin contexts, unlike Rolldown
interface ViteEnvironment {
  mode: string;
  pluginContainer: {
    load(id: string): Promise<string | { code?: string | null } | null | undefined>;
  };
}

// The code of a module that no file holds, like a virtual module or a query variant (`?raw`)
async function getModuleCode(
  context: TransformPluginContext,
  moduleId: string,
): Promise<string | undefined> {
  const { environment } = context as { environment?: ViteEnvironment };

  // Vite's dev server throws on `ModuleInfo.code`, and does not keep the code of the modules loaded
  // through `this.load()`, so their `load` hooks provide it
  if (environment?.mode === 'dev') {
    const loadResult = await environment.pluginContainer.load(moduleId);
    return (typeof loadResult === 'string' ? loadResult : loadResult?.code) ?? undefined;
  }

  return context.getModuleInfo(moduleId)?.code ?? undefined;
}

// Unwraps parentheses and TypeScript type assertions,
// which do not change the runtime value of an expression.
function unwrapExpression(expression: Expression): Expression {
  while (
    expression.type === 'ParenthesizedExpression' ||
    expression.type === 'TSAsExpression' ||
    expression.type === 'TSSatisfiesExpression' ||
    expression.type === 'TSNonNullExpression' ||
    expression.type === 'TSTypeAssertion'
  ) {
    expression = expression.expression;
  }

  return expression;
}

// Splits an identifier, or a chain of members of one, into its name and member names, like
// `ns.inner.x` into `ns` and `['inner', 'x']`. Computed and optional members are not static.
function flattenMemberExpression(
  expression: Expression,
): { name: string; members: string[] } | undefined {
  const members: string[] = [];
  let current = unwrapExpression(expression);

  while (
    current.type === 'MemberExpression' &&
    !current.computed &&
    !current.optional &&
    current.property.type === 'Identifier'
  ) {
    members.unshift(current.property.name);
    current = unwrapExpression(current.object);
  }

  return current.type === 'Identifier' ? { name: current.name, members } : undefined;
}

// The name a TypeScript namespace declaration binds, if any: `A` for
// `namespace A.B {}`, nothing for `declare module 'x' {}`.
function namespaceBindingName(declaration: TSModuleDeclaration): string | undefined {
  let id: TSModuleDeclaration['id'] | TSTypeName = declaration.id;
  while (id.type === 'TSQualifiedName') {
    id = id.left;
  }
  return id.type === 'Identifier' ? id.name : undefined;
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
   * The modules whose CSS interpolates values exported by each file.
   *
   * Key: file path, Value: ids of the modules interpolating its values
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

  // The code of an imported module: from its file, or from the module graph for the modules that
  // no file holds, like virtual modules, and query variants, whose code is not the file's
  async function readModuleCode(
    context: TransformPluginContext,
    moduleId: string,
  ): Promise<string | undefined> {
    const fileCode = moduleId.includes('?')
      ? undefined
      : await context.fs.readFile(moduleId, { encoding: 'utf8' }).catch(() => undefined);

    return fileCode ?? getModuleCode(context, moduleId);
  }

  /**
   * Parses a file and extracts all relevant information in a single pass.
   */
  async function parseFile(
    context: TransformPluginContext,
    filePath: string,
    code?: string,
    lang?: ParseLang,
  ): Promise<ParsedFileInfo> {
    // The code loaded from `readFile` might not be identical
    // to the code passed in after it has been processed by other plugins;
    // as such, we cannot rely on the position of declarations being the same,
    // and the new code should be parsed.
    if (code === undefined && parsedFileInfoCache.has(filePath)) {
      return parsedFileInfoCache.get(filePath)!;
    }

    // Read the source of an imported module. One whose code cannot be read exports nothing.
    const sourceText = code ?? (await readModuleCode(context, filePath)) ?? '';

    // Convert absolute path to project-relative path and normalize to Unix format
    // to ensure consistent hashes across different build environments (Windows/Unix)
    const relativePath = relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');

    // Parse the code as the language Rolldown assigned to the module, like JSX in a .js file
    const parseResult = parseSync(filePath, sourceText, lang === undefined ? undefined : { lang });

    // Imports may only follow the hashbang and the directive prologue (`'use client'`), so the
    // stylesheet imports are injected where the first other statement starts
    const importInsertionPosition =
      parseResult.program.body.find(
        (statement) => !(statement.type === 'ExpressionStatement' && statement.directive != null),
      )?.start ?? parseResult.program.end;
    const declarations = new Map<TaggedTemplateExpression, Declaration>();
    const importedIdentifiers = new Map<string, ImportedIdentifier>();
    const moduleExports = new Map<string, ModuleExport>();
    const exportStarSources: string[] = [];
    const processedTaggedTemplateExpressions = new Set<TaggedTemplateExpression>();
    // Local bindings of `css` imported from 'ecij' (including aliases)
    const cssTagNames = new Set<string>();
    // Positions of the local bindings of the default imports, see the exports below
    const defaultImportPositions = new Set<number>();

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
      importInsertionPosition,
      importedIdentifiers,
      moduleExports,
      exportStarSources,
      rootScope,
    };

    parsedFileInfoCache.set(filePath, parsedInfo);

    // Collect imports
    for (const staticImport of parseResult.module.staticImports) {
      const source = staticImport.moduleRequest.value;

      for (const entry of staticImport.entries) {
        // Type-only imports are erased
        if (entry.isType) continue;

        const localName = entry.localName.value;

        switch (entry.importName.kind) {
          case 'Name': {
            const imported = entry.importName.name!;

            if (source === 'ecij' && imported === 'css') {
              cssTagNames.add(localName);
            }

            importedIdentifiers.set(localName, { kind: 'named', source, imported });
            break;
          }

          case 'Default':
            defaultImportPositions.add(entry.localName.start);
            importedIdentifiers.set(localName, { kind: 'named', source, imported: 'default' });
            break;

          case 'NamespaceObject':
            importedIdentifiers.set(localName, { kind: 'namespace', source });
            break;
        }
      }
    }

    // Collect exports, except `export default <expression>` (see `ExportDefaultDeclaration`)
    for (const staticExport of parseResult.module.staticExports) {
      for (const entry of staticExport.entries) {
        // Type-only exports are erased
        if (entry.isType) continue;

        const source = entry.moduleRequest?.value;

        if (entry.importName.kind === 'AllButDefault') {
          // `export * from 'mod'`
          exportStarSources.push(source!);
          continue;
        }

        if (entry.exportName.kind !== 'Name') continue;

        const exportedName = entry.exportName.name!;

        if (entry.importName.kind === 'All') {
          // `export * as ns from 'mod'`
          moduleExports.set(exportedName, { kind: 'namespace', source: source! });
        } else if (entry.importName.kind === 'Name') {
          // `export { x } from 'mod'`, which oxc also makes of the export of an imported binding.
          // For a default import, it names the local binding instead of `default`.
          const imported = defaultImportPositions.has(entry.importName.start!)
            ? 'default'
            : entry.importName.name!;

          moduleExports.set(exportedName, { kind: 'reexport', source: source!, imported });
        } else {
          const localName = entry.localName.name!;
          const importedIdentifier = importedIdentifiers.get(localName);

          // `import * as ns from 'mod'; export { ns };`
          moduleExports.set(
            exportedName,
            importedIdentifier?.kind === 'namespace'
              ? { kind: 'namespace', source: importedIdentifier.source }
              : { kind: 'local', localName },
          );
        }
      }
    }

    // css`` templates in source order, extracted once the visit completes.
    // Whether the tag is shadowed can only be decided when every scope is fully
    // populated: `let`/`const`/`class` declarations are hoisted to the top of
    // their block (TDZ) and `var`/function declarations to their function scope,
    // so a binding declared *after* the template still shadows the import at
    // the template's position.
    const cssTagCandidates: CssTagCandidate[] = [];

    // Records `node` as a css`` candidate if its tag is a local binding of
    // ecij's `css`; any other tagged template is left alone.
    function addCssTagCandidate(node: TaggedTemplateExpression, localName?: string) {
      processedTaggedTemplateExpressions.add(node);

      if (!(node.tag.type === 'Identifier' && cssTagNames.has(node.tag.name))) {
        return;
      }

      cssTagCandidates.push({
        localName,
        node,
        tagName: node.tag.name,
        scope: currentScope,
      });
    }

    function extractCssTagCandidate({ localName, node, tagName, scope }: CssTagCandidate) {
      // A local binding shadowing the imported tag means this is not the ecij tag
      if (findBindingScope(tagName, scope) !== undefined) {
        return;
      }

      const index = declarations.size;

      // Create a hash from the relative file path, index,
      // and identifier for consistency across builds.
      // The index is always used to avoid collisions with other variables
      // with the same name in the same file.
      const hash = hashText(`${relativePath}:${index}:${localName}`);

      const className = `${classPrefix}${hash}`;

      declarations.set(node, { className, node, scope });
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

      // TypeScript enums and namespaces bind their name in the containing scope, like classes.
      // Only plain Rolldown builds hand raw TypeScript over. Ambient declarations bind nothing.
      TSEnumDeclaration(node) {
        if (!node.declare) {
          currentScope.identifiers.set(node.id.name, undefined);
        }
      },

      TSModuleDeclaration(node) {
        // `declare global {}` and ambient declarations bind nothing
        if (node.global || node.declare) {
          return;
        }

        const name = namespaceBindingName(node);

        if (name !== undefined) {
          currentScope.identifiers.set(name, undefined);
        }
      },

      // A namespace body is a function-like scope of its own
      TSModuleBlock() {
        pushScope(true);
      },
      'TSModuleBlock:exit': popScope,

      // `import x = …` binds `x` in the containing scope, unless it is type-only
      TSImportEqualsDeclaration(node) {
        if (node.importKind !== 'type') {
          currentScope.identifiers.set(node.id.name, undefined);
        }
      },

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
        const init = node.init === null ? null : unwrapExpression(node.init);
        // Only a `const` has a static value: a `let`/`var` may be reassigned,
        // and a `var` is `undefined` until its declaration has run.
        const isConst = variableDeclarationKinds.at(-1) === 'const';

        // Record the initializer of a `const`, resolved on demand, or an unknown
        // value: either way, the binding shadows outer variables
        targetScope.identifiers.set(localName, isConst && init !== null ? init : undefined);

        if (init?.type === 'TaggedTemplateExpression') {
          addCssTagCandidate(init, localName);
        }
      },

      TaggedTemplateExpression(node) {
        if (!processedTaggedTemplateExpressions.has(node)) {
          // No variable name for inline expressions
          addCssTagCandidate(node);
        }
      },

      // `export default <expression>` exports the value of the expression where it appears.
      // Function and class declarations have no static value.
      ExportDefaultDeclaration({ declaration }) {
        if (
          declaration.type === 'FunctionDeclaration' ||
          declaration.type === 'ClassDeclaration' ||
          declaration.type === 'TSInterfaceDeclaration'
        ) {
          return;
        }

        const expression = unwrapExpression(declaration);

        moduleExports.set('default', { kind: 'default', expression });

        if (expression.type === 'TaggedTemplateExpression') {
          addCssTagCandidate(expression, 'default');
        }
      },
    });

    visitor.visit(parseResult.program);

    // Every scope is populated now, so tag shadowing can be decided
    for (const candidate of cssTagCandidates) {
      extractCssTagCandidate(candidate);
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
    meta: { magicString?: RolldownMagicString; moduleType?: string },
  ): Promise<{
    magicString: RolldownMagicString | null;
    importInsertionPosition: number;
    cssContent: string;
    stylesheetDependencies: Set<string>;
  }> {
    const parsedInfo = await parseFile(context, filePath, code, parseLangOf(meta.moduleType));
    const { declarations, importInsertionPosition } = parsedInfo;

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

    // The imported modules, keyed by importer and import path, so that each one is resolved and
    // loaded once per transform
    const importedFiles = new Map<string, Promise<ParsedFileInfo | undefined>>();

    // An export resolved to where it comes from: a binding declared in a module, or the module
    // namespace of `export * as ns`. A name that several `export *` provide through different
    // bindings is ambiguous, so it is not exported at all.
    type ResolvedExport =
      // `*default*` names the binding of `export default <expression>`, like in ECMAScript
      | { kind: 'binding'; fileInfo: ParsedFileInfo; name: string; init: Expression | undefined }
      | { kind: 'namespace'; fileInfo: ParsedFileInfo }
      | { kind: 'ambiguous' };

    // Resolves an import of a file to the parse of the imported module
    function resolveImport(
      source: string,
      fileInfo: ParsedFileInfo,
    ): Promise<ParsedFileInfo | undefined> {
      const key = `${fileInfo.filePath}\0${source}`;
      let importedFile = importedFiles.get(key);

      if (importedFile === undefined) {
        importedFile = loadImport(source, fileInfo.filePath);
        importedFiles.set(key, importedFile);
      }

      return importedFile;
    }

    async function loadImport(
      source: string,
      importer: string,
    ): Promise<ParsedFileInfo | undefined> {
      // Resolve the import path relative to the importer
      const resolvedId = await context.resolve(source, importer);

      // External modules have no code to read values from. Vite's dev server leaves the flag unset.
      if (resolvedId == null || resolvedId.external) {
        return;
      }

      // A query variant, like `?raw`, is a module of its own
      const id = moduleKey(resolvedId.id);

      // Record the dependency so that editing the imported file updates the transformed module
      const file = stripQuery(id);
      let dependents = dependentsPerFile.get(file);

      if (dependents === undefined) {
        dependents = new Set();
        dependentsPerFile.set(file, dependents);
      }

      dependents.add(filePath);

      // Wait for the imported module's transform, which registers the stylesheet imported
      // with its values. Vite's dev server does not transform modules loaded this way, so there
      // the stylesheet is only imported once that module has been transformed.
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

      return parseFile(context, id);
    }

    // Resolves the export `name` of a module to where it comes from, following re-exports and
    // `export *` like ECMAScript's ResolveExport, which `visited` keeps out of re-export cycles
    async function resolveExport(
      fileInfo: ParsedFileInfo,
      name: string,
      visited: Set<string>,
    ): Promise<ResolvedExport | undefined> {
      const key = `${fileInfo.filePath}\0${name}`;

      if (visited.has(key)) {
        return;
      }

      visited.add(key);

      const moduleExport = fileInfo.moduleExports.get(name);

      // Explicit exports take precedence over `export *`, even when their value is unknown
      switch (moduleExport?.kind) {
        case 'local':
          return {
            kind: 'binding',
            fileInfo,
            name: moduleExport.localName,
            init: fileInfo.rootScope.identifiers.get(moduleExport.localName),
          };

        case 'default':
          return { kind: 'binding', fileInfo, name: '*default*', init: moduleExport.expression };

        case 'reexport':
        case 'namespace': {
          const importedFileInfo = await resolveImport(moduleExport.source, fileInfo);

          if (importedFileInfo === undefined) {
            return;
          }

          return moduleExport.kind === 'namespace'
            ? { kind: 'namespace', fileInfo: importedFileInfo }
            : resolveExport(importedFileInfo, moduleExport.imported, visited);
        }
      }

      // `export *` does not provide the default export
      if (name === 'default') {
        return;
      }

      // The bindings that the `export *` provide the name through, keyed by module and name
      const candidates = new Map<string, ResolvedExport>();

      for (const source of fileInfo.exportStarSources) {
        const importedFileInfo = await resolveImport(source, fileInfo);

        if (importedFileInfo === undefined) continue;

        const candidate = await resolveExport(importedFileInfo, name, visited);

        if (candidate === undefined) continue;

        // A name that is ambiguous in a source is ambiguous here too
        if (candidate.kind === 'ambiguous') {
          return candidate;
        }

        candidates.set(
          `${candidate.fileInfo.filePath}\0${candidate.kind === 'binding' ? candidate.name : ''}`,
          candidate,
        );
      }

      return candidates.size > 1 ? { kind: 'ambiguous' } : candidates.values().next().value;
    }

    // Resolves the value of an export, whose module's stylesheet is imported first, as its class
    // names may be part of the value
    async function resolveExportValue(
      resolvedExport: ResolvedExport | undefined,
    ): Promise<string | undefined> {
      if (resolvedExport?.kind !== 'binding' || resolvedExport.init === undefined) {
        return;
      }

      const { fileInfo, init } = resolvedExport;
      const value = await resolveInitializer(init, fileInfo.rootScope, fileInfo);

      if (value !== undefined && fileInfo.filePath !== filePath) {
        const stylesheetImport = stylesheetImportPerFile.get(fileInfo.filePath);

        if (stylesheetImport !== undefined) {
          stylesheetDependencies.add(stylesheetImport);
        }
      }

      return value;
    }

    // Statically evaluates an expression of a file, like an interpolation or the initializer of a
    // `const`, to its string value: a string or number literal, including signed numbers (`-5`,
    // `+5`), or an identifier bound to such a value or to a class name, in the file or imported,
    // including the members of imported module namespaces (`ns.x`). Parentheses and TypeScript
    // type assertions are ignored.
    async function resolveValue(
      expression: Expression,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
      expression = unwrapExpression(expression);

      if (
        expression.type === 'Literal' &&
        (typeof expression.value === 'string' || typeof expression.value === 'number')
      ) {
        return String(expression.value);
      }

      if (expression.type === 'UnaryExpression') {
        const argument = unwrapExpression(expression.argument);

        if (
          (expression.operator === '-' || expression.operator === '+') &&
          argument.type === 'Literal' &&
          typeof argument.value === 'number'
        ) {
          return String(expression.operator === '-' ? -argument.value : argument.value);
        }
      }

      const path = flattenMemberExpression(expression);

      if (path === undefined) {
        return;
      }

      const { name, members } = path;

      // Walk up the scope chain to find the identifier
      const bindingScope = findBindingScope(name, scope);

      if (bindingScope !== undefined) {
        // Only the namespaces of imported modules have members to resolve
        return members.length === 0 ? resolveBinding(name, bindingScope, fileInfo) : undefined;
      }

      // Check if it's an imported identifier
      const importedIdentifier = fileInfo.importedIdentifiers.get(name);

      if (importedIdentifier === undefined) {
        return;
      }

      const importedFileInfo = await resolveImport(importedIdentifier.source, fileInfo);

      if (importedFileInfo === undefined) {
        return;
      }

      // A namespace import is the namespace of the imported module, which a named import can be
      // too, through `export * as ns from 'mod'`
      let resolvedExport: ResolvedExport | undefined =
        importedIdentifier.kind === 'namespace'
          ? { kind: 'namespace', fileInfo: importedFileInfo }
          : await resolveExport(importedFileInfo, importedIdentifier.imported, new Set());

      // Each member is an export of the namespace before it
      for (const member of members) {
        if (resolvedExport?.kind !== 'namespace') {
          return;
        }

        resolvedExport = await resolveExport(resolvedExport.fileInfo, member, new Set());
      }

      return resolveExportValue(resolvedExport);
    }

    // Resolves the binding `name` declared in `scope`, like `resolveInitializer`. Other bindings
    // have unknown values (like function params), which stops the lookup and signals "can't
    // resolve".
    async function resolveBinding(
      name: string,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
      const init = scope.identifiers.get(name);

      return init === undefined ? undefined : resolveInitializer(init, scope, fileInfo);
    }

    // Resolves the initializer of a `const` or the expression of an `export default`: a css``
    // template takes its class name, and any other expression its value
    async function resolveInitializer(
      init: Expression,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
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
    for (const { className, node, scope } of declarations.values()) {
      const { quasis, expressions } = node.quasi;

      let cssContent = '';
      let allResolved = true;

      for (let i = 0; i < quasis.length; i++) {
        cssContent += quasis[i]!.value.raw;

        if (i < expressions.length) {
          const expression = expressions[i]!;

          const resolvedValue = await resolveValue(expression, scope, parsedInfo);

          if (resolvedValue === undefined) {
            const path = flattenMemberExpression(expression);

            if (path === undefined) {
              // Complex expression - skip this entire css`` block
              context.warn(
                {
                  pluginCode: 'COMPLEX_INTERPOLATION',
                  message:
                    'skipped CSS extraction — interpolation is not a static string, number, or identifier',
                },
                expression.start,
              );
            } else {
              // Cannot resolve - skip this entire css`` block
              context.warn(
                {
                  pluginCode: 'UNRESOLVED_INTERPOLATION',
                  message: `skipped CSS extraction — could not resolve "${[path.name, ...path.members].join('.')}" to a static string or number`,
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
        importInsertionPosition,
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
      importInsertionPosition,
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
      // The dev server keeps the caches until it closes. Forget the parse of the edited module and
      // of its query variants, and the stylesheets that change with it: its own, and those of the
      // modules that interpolate its values. Keep their CSS, as cached transforms may still import
      // it.
      for (const moduleId of parsedFileInfoCache.keys()) {
        if (stripQuery(moduleId) === id) parsedFileInfoCache.delete(moduleId);
      }

      for (const moduleId of stylesheetImportPerFile.keys()) {
        if (stripQuery(moduleId) === id) stylesheetImportPerFile.delete(moduleId);
      }

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
      const { moduleGraph } = this.environment;

      for (const dependentId of dependentsPerFile.get(file) ?? []) {
        for (const id of [dependentId, ...(dependentsPerFile.get(stripQuery(dependentId)) ?? [])]) {
          for (const moduleNode of moduleGraph.getModulesByFile(stripQuery(id)) ?? []) {
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
        // The module's identity: a query variant, like an inline script of an HTML page, is a
        // module of its own, with its own parse, class names, and stylesheet
        const moduleId = moduleKey(id);

        // Extract CSS from the code
        const { magicString, importInsertionPosition, cssContent, stylesheetDependencies } =
          await extractCssFromCode(this, code, moduleId, meta);

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
          const cssModuleId = `${stripQuery(moduleId)}.${hash}.css`;

          // Store the CSS extractions for this file
          extractedCssPerFile.set(cssModuleId, cssContent);
          stylesheetImportPerFile.set(moduleId, cssModuleId);

          const importStatements: string[] = [];

          // Import the stylesheets of the modules whose class names were interpolated into
          // the CSS above, ahead of this module's own. These statements are injected at the
          // top of the file, so leaving them out would emit this module's CSS before the CSS
          // it references, inverting the cascade.
          for (const id of stylesheetDependencies) {
            importStatements.push(`import ${JSON.stringify(id)};\n`);
          }

          // use JSON.stringify to properly escape the module ID,
          // including \ delimiters on Windows.
          importStatements.push(`import ${JSON.stringify(cssModuleId)};\n`);

          // Add side-effect/CSS module imports at the top of the file, after any hashbang and
          // directive prologue
          magicString.appendLeft(importInsertionPosition, importStatements.join(''));
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
