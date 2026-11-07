import { hash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';

import type {
  BindingPattern,
  BlockStatement,
  Expression,
  ModuleExportName,
  ParamPattern,
  Program,
  SwitchCase,
  TaggedTemplateExpression,
} from '@oxc-project/types';
import { RolldownMagicString, type Plugin, type TransformPluginContext } from 'rolldown';
import { makeIdFiltersToMatchWithQuery } from 'rolldown/filter';
import { parseSync, Visitor } from 'rolldown/utils';
import type { Vite } from 'vitest/node';

/**
 * Options for the {@link ecij} plugin.
 */
export interface Configuration {
  /**
   * Include patterns for files to process, matched against the module ID.
   *
   * @default `/\.[cm]?[jt]sx?$/`
   */
  include?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Exclude patterns for files to skip, matched against the module ID.
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

type MaybePromise<T> = T | Promise<T>;

/** A binding imported by name from another module. */
interface ImportBinding {
  type: 'ImportBinding';
  source: string;
  /** Name of the binding in the module it is imported from. */
  imported: string;
}

/** The namespace of another module, imported with `import * as ns`. */
interface NamespaceImport {
  type: 'NamespaceImport';
  source: string;
}

interface Scope {
  /**
   * The initializer of each `const` or the import of each imported binding, resolved on demand, or
   * `undefined` for the bindings whose value is unknown at build time (like function params).
   */
  identifiers: Map<string, Expression | ImportBinding | NamespaceImport | undefined>;
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

type ModuleExport =
  // `export { x }`, `export const x = …`, and `export default`: a binding of the module-level scope
  | { kind: 'local'; localName: string }
  // `export { x } from 'mod'`, and the export of a binding imported from 'mod'
  | { kind: 'reexport'; source: string; imported: string }
  // `export * as ns from 'mod'`, and the export of `import * as ns from 'mod'`
  | { kind: 'namespace'; source: string };

interface ParsedFileInfo {
  /** Module ID the file was parsed for, which its imports are resolved from. */
  readonly filePath: string;
  /** The css`` templates to extract in source order, keyed by template. */
  readonly declarations: ReadonlyMap<TaggedTemplateExpression, Declaration>;
  /** Where the stylesheet imports go: after the hashbang and the directive prologue. */
  readonly importInsertionPosition: number;
  /** The exports of the module, keyed by exported name, except those of `export *`. */
  readonly moduleExports: ReadonlyMap<string, ModuleExport>;
  /** Sources of `export * from 'mod'`, which provide the other names, except `default`. */
  readonly exportStarSources: readonly string[];
  /** Module-level scope, where the imports and the exported bindings are declared. */
  readonly rootScope: Scope;
}

// Languages the parser can be told to parse a module as, see `meta.moduleType`
type ParseLang = 'js' | 'jsx' | 'ts' | 'tsx';

// Allow .js, .cjs, .mjs, .ts, .cts, .mts, .jsx, and .tsx files
const JS_TS_FILE_REGEX = /\.[cm]?[jt]sx?$/;

// Disallow /node_modules/ and .d.ts files
const NODE_MODULES_REGEX = /\/node_modules\//;
const D_TS_FILE_REGEX = /\.d\.ts$/;

// Match the generated stylesheet IDs, like /src/Button.tsx.1a2b3c4d.css
const STYLESHEET_ID_REGEX = /\.[0-9a-f]{8}\.css$/;

// The local name of the value of `export default`, as the spec names it, which no identifier can be
const DEFAULT_EXPORT_LOCAL_NAME = '*default*';

// Queries Vite appends to the IDs of the modules it serves without changing their code, like
// cache busting. Any other query denotes a module with code of its own, like `?raw` (the text of
// the file), `?url` (its URL), or `?html-proxy` (an inline script of an HTML page).
const TRANSPARENT_QUERY_KEYS = new Set(['v', 't', 'import', 'direct', 'used']);

const PARSE_LANGS: ReadonlySet<string> = new Set<ParseLang>(['js', 'jsx', 'ts', 'tsx']);

// Get the project root directory
const PROJECT_ROOT = cwd();

function hashText(text: string): string {
  return hash('md5', text).slice(0, 8);
}

// The language a module was assigned, if the parser can parse it as such. Otherwise the parser
// infers it from the file name.
function parseLangOf(moduleType: string): ParseLang | undefined {
  return PARSE_LANGS.has(moduleType) ? (moduleType as ParseLang) : undefined;
}

// The name of an imported or exported binding, which can be a string: `export { a as "b" }`
function nameOf(name: ModuleExportName): string {
  return name.type === 'Literal' ? name.value : name.name;
}

// Removes the query of a module ID, like `/src/a.ts?raw` -> `/src/a.ts`
function stripQuery(id: string): string {
  const queryIndex = id.indexOf('?');
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

// The identity of a module, under which its parse and stylesheet are kept: its ID, without the
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

// The innermost scope of the chain that binds `name`, shadowing outer bindings and imports.
function findBindingScope(name: string, scope: Scope): Scope | undefined {
  for (let current: Scope | null = scope; current !== null; current = current.parent) {
    if (current.identifiers.has(name)) return current;
  }
  return;
}

// Whether `name` is bound to ecij's `css` in `scope`, which a local binding of the same name shadows
function isCssTag(name: string, scope: Scope): boolean {
  const binding = findBindingScope(name, scope)?.identifiers.get(name);

  return (
    binding?.type === 'ImportBinding' && binding.source === 'ecij' && binding.imported === 'css'
  );
}

// State of the program that `SCOPE_VISITOR` is visiting, see `visitProgram`
let currentScope: Scope;
let cssTagCandidates: Map<TaggedTemplateExpression, CssTagCandidate>;
// Function bodies are function scopes of their own, see `BlockStatement`
const functionBodies = new Set<BlockStatement>();
// The switch scope is entered with the first case, see `SwitchStatement`
const firstSwitchCases = new Set<SwitchCase>();
// Kinds of the `VariableDeclaration`s being visited, innermost last. An
// initializer can itself contain declarations, like a function body, so a
// single slot would be clobbered before the next declarator is visited.
const variableDeclarationKinds: string[] = [];

function addCssTagCandidate(node: TaggedTemplateExpression, name?: string) {
  cssTagCandidates.set(node, { name, scope: currentScope });
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

// Visit the AST to record the bindings of each scope and the tagged templates
const SCOPE_VISITOR = new Visitor({
  BlockStatement(node) {
    // A function body is where its `var` declarations hoist to. Parameter
    // defaults are evaluated in the enclosing parameter scope and cannot
    // see the body's declarations. Visited bodies are removed, so that the
    // set does not keep the nodes of past visits.
    pushScope(functionBodies.delete(node));
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
    // Removed when visited, like function bodies
    if (firstSwitchCases.delete(node)) {
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

  // TypeScript enums bind their name in the containing scope, like classes. Only plain Rolldown
  // builds hand raw TypeScript over. Ambient declarations bind nothing.
  TSEnumDeclaration(node) {
    if (!node.declare) {
      currentScope.identifiers.set(node.id.name, undefined);
    }
  },

  // TypeScript namespaces are not supported, but they get a scope of their own, so that their
  // declarations cannot override the module's bindings, ecij's `css` included. `TSModuleBlock` is
  // also the body of `declare module` and `declare global` blocks. A namespace compiles to a
  // function, so it is function-scoped for `var` declarations.
  TSModuleBlock() {
    pushScope(true);
  },
  'TSModuleBlock:exit': popScope,

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
    // Declarators add their templates first, with the variable name
    if (!cssTagCandidates.has(node)) {
      // No variable name for inline expressions
      addCssTagCandidate(node);
    }
  },
});

/**
 * Populates the scopes of a program from its module-level scope, and returns its tagged templates
 * in source order, keyed by template. Whether a tag is ecij's `css` can only be decided once every
 * scope is fully populated: `let`/`const`/`class` declarations are hoisted to the top of their
 * block (TDZ) and `var`/function declarations to their function scope, so a binding declared
 * *after* the template still shadows the import at the template's position.
 *
 * A visit is synchronous, so a single visitor and its state serve every parse. A visitor per parse
 * would create its callbacks and compile them every time, and `Visitor` keeps the callbacks of
 * every instance alive, along with everything they reference:
 * https://github.com/oxc-project/oxc/issues/25510
 */
function visitProgram(
  program: Program,
  rootScope: Scope,
): Map<TaggedTemplateExpression, CssTagCandidate> {
  currentScope = rootScope;
  cssTagCandidates = new Map();
  SCOPE_VISITOR.visit(program);
  return cssTagCandidates;
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

  /**
   * The parse of each module, of its transformed code or of the file read from disk, cached as
   * soon as it is requested.
   *
   * Key: module ID, Value: parse of the module
   */
  const parsedFileInfoCache = new Map<string, MaybePromise<ParsedFileInfo>>();

  /**
   * Generated CSS module IDs for each source file, imported ahead of the stylesheet of any
   * module that interpolates its class names, to preserve the cascade order.
   *
   * Key: module ID, Value: CSS module ID
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
   * Key: file path, Value: IDs of the modules interpolating its values
   */
  const dependentsPerFile = new Map<string, Set<string>>();

  /**
   * The module that each running transform is waiting for through `this.load()`.
   *
   * Key: module ID, Value: module ID
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
   * Parses the code of a file and extracts all relevant information in a single pass.
   */
  function parseFile(filePath: string, code: string, lang?: ParseLang): ParsedFileInfo {
    // Parse the code as the language the module was assigned, like JSX in a .js file
    const { program } = parseSync(filePath, code, lang === undefined ? undefined : { lang });
    // Scope tracking: root scope for imports and module-level declarations
    const rootScope: Scope = { identifiers: new Map(), parent: null, isFunctionScope: true };
    const moduleExports = new Map<string, ModuleExport>();
    const exportStarSources: string[] = [];

    // Imports may only follow the hashbang and the directive prologue (`'use client'`), so the
    // stylesheet imports are injected where the first other statement starts
    const importInsertionPosition =
      program.body.find(
        (statement) => !(statement.type === 'ExpressionStatement' && statement.directive != null),
      )?.start ?? program.end;

    // Collect the imports and exports from the top-level statements. The parse result's module
    // record lists them too, but converting it to JS objects takes longer than this loop, and
    // `SCOPE_VISITOR` would also visit the declarations nested in TypeScript namespaces. Type-only
    // imports and exports are erased, so they bind and export nothing.
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration') {
        if (statement.importKind === 'type') continue;

        const source = statement.source.value;

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            rootScope.identifiers.set(specifier.local.name, { type: 'NamespaceImport', source });
          } else if (specifier.type === 'ImportDefaultSpecifier') {
            rootScope.identifiers.set(specifier.local.name, {
              type: 'ImportBinding',
              source,
              imported: 'default',
            });
          } else if (specifier.importKind !== 'type') {
            rootScope.identifiers.set(specifier.local.name, {
              type: 'ImportBinding',
              source,
              imported: nameOf(specifier.imported),
            });
          }
        }
      } else if (statement.type === 'ExportNamedDeclaration') {
        if (statement.exportKind === 'type') continue;

        const source = statement.source?.value;

        for (const specifier of statement.specifiers) {
          if (specifier.exportKind === 'type') continue;

          moduleExports.set(
            nameOf(specifier.exported),
            source === undefined
              ? { kind: 'local', localName: nameOf(specifier.local) }
              : { kind: 'reexport', source, imported: nameOf(specifier.local) },
          );
        }

        const { declaration } = statement;

        // Exported declarations take precedence over `export *` even when their value is unknown
        if (declaration?.type === 'VariableDeclaration') {
          for (const { id } of declaration.declarations) {
            if (id.type === 'Identifier') {
              moduleExports.set(id.name, { kind: 'local', localName: id.name });
            } else {
              // A destructuring pattern exports every binding it declares
              const patternScope: Scope = {
                identifiers: new Map(),
                parent: null,
                isFunctionScope: true,
              };
              recordBindingPattern(id, patternScope);

              for (const name of patternScope.identifiers.keys()) {
                moduleExports.set(name, { kind: 'local', localName: name });
              }
            }
          }
        } else if (
          (declaration?.type === 'FunctionDeclaration' ||
            declaration?.type === 'ClassDeclaration' ||
            declaration?.type === 'TSEnumDeclaration') &&
          declaration.id !== null
        ) {
          moduleExports.set(declaration.id.name, { kind: 'local', localName: declaration.id.name });
        }
      } else if (statement.type === 'ExportAllDeclaration') {
        if (statement.exportKind === 'type') continue;

        if (statement.exported === null) {
          exportStarSources.push(statement.source.value);
        } else {
          moduleExports.set(nameOf(statement.exported), {
            kind: 'namespace',
            source: statement.source.value,
          });
        }
      } else if (statement.type === 'ExportDefaultDeclaration') {
        // Bind the exported value, unless it is a TypeScript interface, which has none
        if (statement.declaration.type !== 'TSInterfaceDeclaration') {
          rootScope.identifiers.set(
            DEFAULT_EXPORT_LOCAL_NAME,
            unwrapExpression(statement.declaration),
          );
          moduleExports.set('default', { kind: 'local', localName: DEFAULT_EXPORT_LOCAL_NAME });
        }
      }
    }

    // The export of an imported binding re-exports it, like in ECMAScript, so that `export *` sees
    // that two modules export the same binding
    for (const [exportedName, moduleExport] of moduleExports) {
      if (moduleExport.kind !== 'local') continue;

      const binding = rootScope.identifiers.get(moduleExport.localName);

      if (binding?.type === 'ImportBinding') {
        moduleExports.set(exportedName, {
          kind: 'reexport',
          source: binding.source,
          imported: binding.imported,
        });
      } else if (binding?.type === 'NamespaceImport') {
        moduleExports.set(exportedName, { kind: 'namespace', source: binding.source });
      }
    }

    const cssTagCandidates = visitProgram(program, rootScope);

    // Convert absolute path to project-relative path and normalize to Unix format
    // to ensure consistent hashes across different build environments (Windows/Unix)
    const relativePath = relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');
    const declarations = new Map<TaggedTemplateExpression, Declaration>();

    // Every scope is populated now, so tag shadowing can be decided
    for (const [node, { name, scope }] of cssTagCandidates) {
      // Skip other tags, including local bindings shadowing the imported one
      if (node.tag.type !== 'Identifier' || !isCssTag(node.tag.name, scope)) {
        continue;
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

    return {
      filePath,
      declarations,
      importInsertionPosition,
      moduleExports,
      exportStarSources,
      rootScope,
    };
  }

  /**
   * The parse of a module that values are imported from, cached or read from disk. The parse of
   * the file is cached while it is pending: the transforms of the modules importing it run
   * concurrently, so they would otherwise all miss the cache, and each read and parse the file.
   */
  function loadParsedFile(
    context: TransformPluginContext,
    filePath: string,
  ): MaybePromise<ParsedFileInfo> {
    let parsedInfo = parsedFileInfoCache.get(filePath);

    if (parsedInfo === undefined) {
      parsedInfo = readParsedFile(context, filePath);
      parsedFileInfoCache.set(filePath, parsedInfo);
    }

    return parsedInfo;
  }

  // Reads and parses an imported module. One whose code cannot be read exports nothing.
  async function readParsedFile(
    context: TransformPluginContext,
    filePath: string,
  ): Promise<ParsedFileInfo> {
    return parseFile(filePath, (await readModuleCode(context, filePath)) ?? '');
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
    meta: { magicString?: RolldownMagicString; moduleType: string },
  ): Promise<{
    magicString: RolldownMagicString | null;
    importInsertionPosition: number;
    cssContent: string;
    stylesheetDependencies: Set<string>;
  }> {
    // Parse the code being transformed, as other plugins may have changed it since it was read
    // from disk, and share the parse with the transforms that interpolate its values
    const parsedInfo = parseFile(filePath, code, parseLangOf(meta.moduleType));
    parsedFileInfoCache.set(filePath, parsedInfo);
    const { declarations, importInsertionPosition } = parsedInfo;

    // Created with the first extraction, so files without any are returned untouched
    let magicString: RolldownMagicString | null = null;
    // CSS module content, in the source order of the declarations
    let cssContent = '';
    const stylesheetDependencies = new Set<string>();

    // Values of the `const` and imported bindings resolved so far, unknown ones included, keyed by
    // initializer or import. A binding is cached as unknown while it is resolved, so that a cycle
    // stays unknown, and its value replaces it once resolved: a cached promise would make a cycle
    // wait for itself. The cache is not shared with other transforms, as values read through
    // imports can change in between.
    const bindingValues = new Map<Expression | ImportBinding, string | undefined>();

    // The modules that interpolated values come from, re-exports included, keyed by importer and
    // import source, so that each one is resolved, loaded, and parsed once per transform
    const importedModules = new Map<string, ReturnType<typeof resolveImportedModule>>();

    function loadImportedModule(source: string, importer: string) {
      const key = `${importer}\0${source}`;
      let importedModule = importedModules.get(key);

      if (importedModule === undefined) {
        importedModule = resolveImportedModule(source, importer);
        importedModules.set(key, importedModule);
      }

      return importedModule;
    }

    async function resolveImportedModule(
      source: string,
      importer: string,
    ): Promise<ParsedFileInfo | undefined> {
      // Resolve the import path relative to the importer
      const resolvedId = await context.resolve(source, importer);

      // External modules have no code to read values from. Vite's dev server leaves the flag unset.
      if (resolvedId == null || resolvedId.external) return;

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

      // Wait for the imported module's transform, which registers the stylesheet imported with
      // its values. Vite's dev server does not transform modules loaded this way, so there the
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

      return loadParsedFile(context, id);
    }

    // An export resolved to where it comes from: a binding of a module-level scope, or the
    // namespace of a module. A name that several `export *` provide through different bindings is
    // ambiguous, so it is not exported at all.
    type ResolvedExport =
      | { kind: 'binding'; fileInfo: ParsedFileInfo; localName: string }
      | { kind: 'namespace'; fileInfo: ParsedFileInfo }
      | { kind: 'ambiguous' };

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
          return { kind: 'binding', fileInfo, localName: moduleExport.localName };

        case 'reexport':
        case 'namespace': {
          const importedFileInfo = await loadImportedModule(moduleExport.source, fileInfo.filePath);

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
        const importedFileInfo = await loadImportedModule(source, fileInfo.filePath);

        if (importedFileInfo === undefined) continue;

        const candidate = await resolveExport(importedFileInfo, name, visited);

        if (candidate === undefined) continue;

        // A name that is ambiguous in a source is ambiguous here too
        if (candidate.kind === 'ambiguous') {
          return candidate;
        }

        candidates.set(
          `${candidate.fileInfo.filePath}\0${candidate.kind === 'binding' ? candidate.localName : ''}`,
          candidate,
        );
      }

      return candidates.size > 1 ? { kind: 'ambiguous' } : candidates.values().next().value;
    }

    // The export that an import refers to: the namespace of the imported module for a namespace
    // import, which a named import can be too, through `export * as ns from 'mod'`
    async function resolveImportedExport(
      binding: ImportBinding | NamespaceImport,
      fileInfo: ParsedFileInfo,
    ): Promise<ResolvedExport | undefined> {
      const importedFileInfo = await loadImportedModule(binding.source, fileInfo.filePath);

      if (importedFileInfo === undefined) {
        return;
      }

      return binding.type === 'NamespaceImport'
        ? { kind: 'namespace', fileInfo: importedFileInfo }
        : resolveExport(importedFileInfo, binding.imported, new Set());
    }

    // Resolves the value of an export, whose module's stylesheet is imported first, as its class
    // names may be part of the value
    async function resolveExportValue(
      resolvedExport: ResolvedExport | undefined,
    ): Promise<string | undefined> {
      if (resolvedExport?.kind !== 'binding') {
        return;
      }

      const { fileInfo, localName } = resolvedExport;
      const value = await resolveBinding(localName, fileInfo.rootScope, fileInfo);

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
    // type assertions are ignored. The value is only returned as a promise when an import has to
    // be loaded first.
    function resolveValue(
      expression: Expression,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): MaybePromise<string | undefined> {
      expression = unwrapExpression(expression);

      if (expression.type === 'Literal') {
        if (typeof expression.value === 'string' || typeof expression.value === 'number') {
          return String(expression.value);
        }
        return;
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
        return;
      }

      const path = flattenMemberExpression(expression);

      if (path === undefined) {
        return;
      }

      // Walk up the scope chain to find the identifier, imports included
      const bindingScope = findBindingScope(path.name, scope);

      if (bindingScope === undefined) {
        return;
      }

      if (path.members.length === 0) {
        return resolveBinding(path.name, bindingScope, fileInfo);
      }

      return resolveMembers(bindingScope.identifiers.get(path.name), path.members, fileInfo);
    }

    // Resolves the members of an imported module namespace, like `ns.inner.x`, each an export of
    // the namespace before it
    async function resolveMembers(
      binding: Expression | ImportBinding | NamespaceImport | undefined,
      members: readonly string[],
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
      // Only the namespaces of imported modules have members to resolve
      if (binding?.type !== 'ImportBinding' && binding?.type !== 'NamespaceImport') {
        return;
      }

      let resolvedExport = await resolveImportedExport(binding, fileInfo);

      for (const member of members) {
        if (resolvedExport?.kind !== 'namespace') {
          return;
        }

        resolvedExport = await resolveExport(resolvedExport.fileInfo, member, new Set());
      }

      return resolveExportValue(resolvedExport);
    }

    // Resolves the binding `name` declared in `scope`: a `const` takes the class name of its css``
    // template or the value of its initializer, and an import the value that its module exports.
    // Other bindings have unknown values (like function params), which stops the lookup and
    // signals "can't resolve", like a module namespace, which is not a string.
    function resolveBinding(
      name: string,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): MaybePromise<string | undefined> {
      const binding = scope.identifiers.get(name);

      if (binding === undefined || binding.type === 'NamespaceImport') {
        return;
      }

      if (binding.type === 'TaggedTemplateExpression') {
        // Templates whose tag is not ecij's `css` have no class name
        return fileInfo.declarations.get(binding)?.className;
      }

      if (bindingValues.has(binding)) {
        return bindingValues.get(binding);
      }

      bindingValues.set(binding, undefined);

      const value =
        binding.type === 'ImportBinding'
          ? resolveImport(binding, fileInfo)
          : resolveValue(binding, scope, fileInfo);

      if (value instanceof Promise) {
        return value.then((resolvedValue) => {
          bindingValues.set(binding, resolvedValue);
          return resolvedValue;
        });
      }

      bindingValues.set(binding, value);
      return value;
    }

    // Resolves an import of a file to the value of the binding that its module exports by that
    // name, following re-exports
    async function resolveImport(
      binding: ImportBinding,
      fileInfo: ParsedFileInfo,
    ): Promise<string | undefined> {
      return resolveExportValue(await resolveImportedExport(binding, fileInfo));
    }

    // Build the CSS of each template, resolving its interpolations
    for (const [node, { className, scope }] of declarations) {
      const { quasis, expressions } = node.quasi;

      let templateCss = '';
      let allResolved = true;

      for (let i = 0; i < quasis.length; i++) {
        templateCss += quasis[i]!.value.raw;

        if (i < expressions.length) {
          const expression = expressions[i]!;

          const resolvedValue = await resolveValue(expression, scope, parsedInfo);

          if (resolvedValue === undefined) {
            const path = flattenMemberExpression(expression);

            if (path === undefined) {
              // Complex expression — skip this entire css`` block
              context.warn(
                {
                  pluginCode: 'COMPLEX_INTERPOLATION',
                  message:
                    'skipped CSS extraction — interpolation is not a static string, number, or identifier',
                },
                expression.start,
              );
            } else {
              // Cannot resolve — skip this entire css`` block
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

          templateCss += resolvedValue;
        }
      }

      // Only extract the template if all its interpolations were resolved
      if (!allResolved) {
        continue;
      }

      // Apply replacements through a magic string,
      // so an accurate sourcemap can be generated for the edits
      magicString ??= meta.magicString ?? new RolldownMagicString(code);

      // Emit each class name as an IIFE instead of a literal to prevent issues with tree-shaking
      // (see inlineConst tests): `optimization.inlineConst` inlines string and template literal
      // constants, and once all used exports of a `sideEffects: false` module are inlined, the
      // module is dropped along with its stylesheet import. Rolldown does not evaluate calls as
      // constants, yet still treats the IIFE as side-effect-free, and minifiers fold it back to a
      // plain string. Do not annotate it with `@__PURE__`: terser does not inline annotated IIFEs.
      // Related upstream issues (Vite's own CSS Modules lose their CSS the same way):
      // https://github.com/vitejs/vite/issues/22344
      // https://github.com/rolldown/rolldown/issues/8100
      magicString.overwrite(node.start, node.end, `(() => ${JSON.stringify(className)})()`);

      templateCss = templateCss.trim();

      if (templateCss !== '') {
        if (cssContent !== '') {
          cssContent += '\n\n';
        }

        cssContent += `.${className} {\n  ${templateCss}\n}`;
      }
    }

    return {
      magicString,
      importInsertionPosition,
      cssContent,
      stylesheetDependencies,
    };
  }

  // Rolldown's plugin type does not include the hooks of Vite and Vitest, which Rolldown ignores
  const plugin: Plugin & Pick<Vite.Plugin, 'hotUpdate' | 'configureVitest'> = {
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
      const dependents = dependentsPerFile.get(file);

      // Leave the update to Vite when no CSS depends on the edited module
      if (dependents === undefined) {
        return;
      }

      // Vite reuses the transforms of the modules that import an edited module, only updating
      // their imports. Update the modules that interpolate its values as if they were edited,
      // as they import its stylesheet and their CSS may change, and the modules that interpolate
      // their class names, as they import their stylesheets.
      const updatedModules = new Set(modules);
      const { moduleGraph } = this.environment;

      for (const dependentId of dependents) {
        for (const id of [dependentId, ...(dependentsPerFile.get(stripQuery(dependentId)) ?? [])]) {
          for (const moduleNode of moduleGraph.getModulesByFile(stripQuery(id)) ?? []) {
            updatedModules.add(moduleNode);
          }
        }
      }

      return [...updatedModules];
    },

    configureVitest({ defineCacheKeyGenerator }) {
      // Vitest's `fsModuleCache` reuses transformed modules across runs without calling
      // `transform`, which registers their stylesheets, and only keys them on their own content,
      // while their CSS can depend on the values they import. Keep the modules that `transform`
      // handles out of it, like its `code` filter.
      defineCacheKeyGenerator(({ sourceCode }) =>
        sourceCode.includes('ecij') ? false : undefined,
      );
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

          let importStatements = '';

          // Import the stylesheets of the modules whose class names were interpolated into
          // the CSS above, ahead of this module's own. These statements are injected at the
          // top of the file, so leaving them out would emit this module's CSS before the CSS
          // it references, inverting the cascade.
          for (const id of stylesheetDependencies) {
            importStatements += `import ${JSON.stringify(id)};\n`;
          }

          // Use JSON.stringify to properly escape the module ID,
          // including \ separators on Windows.
          importStatements += `import ${JSON.stringify(cssModuleId)};\n`;

          // Add side-effect/CSS module imports at the top of the file, after any hashbang and
          // directive prologue
          magicString.appendLeft(importInsertionPosition, importStatements);
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
