import { hash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';

import type {
  BindingPattern,
  BlockStatement,
  Expression,
  MemberExpression,
  ModuleExportName,
  ParamPattern,
  Program,
  SwitchCase,
  TaggedTemplateExpression,
  UnaryOperator,
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

interface ParsedFileInfo {
  /** Module ID the file was parsed for, which its imports are resolved from. */
  readonly filePath: string;
  /** The css`` templates to extract in source order, keyed by template. */
  readonly declarations: ReadonlyMap<TaggedTemplateExpression, Declaration>;
  /** Local names of the exported bindings, keyed by exported name. */
  readonly exportedLocalNames: ReadonlyMap<string, string>;
  /** Module-level scope, where the imports and the exported bindings are declared. */
  readonly rootScope: Scope;
}

// A value known at build time: a string, numbers and class names included, or the namespace of a
// module, represented by its parse, whose members are the exports of the module
type StaticValue = string | ParsedFileInfo;

// Languages the parser can be told to parse a module as, see `meta.moduleType`
type ParseLang = 'js' | 'jsx' | 'ts' | 'tsx';

// Allow .js, .cjs, .mjs, .ts, .cts, .mts, .jsx, and .tsx files
const JS_TS_FILE_REGEX = /\.[cm]?[jt]sx?$/;

// Disallow /node_modules/ and .d.ts files
const NODE_MODULES_REGEX = /\/node_modules\//;
const D_TS_FILE_REGEX = /\.d\.ts$/;

// Match the named imports from ecij, the only way to import its `css` tag, like
// `import { css } from 'ecij'`, with or without spaces, as minified code has none
const ECIJ_IMPORT_REGEX = /\}\s*from\s*["']ecij["']/;

// Match the generated stylesheet IDs, like /src/Button.tsx.1a2b3c4d.css
const STYLESHEET_ID_REGEX = /\.[0-9a-f]{8}\.css$/;

// The local name of the value of `export default`, as the spec names it, which no identifier can be
const DEFAULT_EXPORT_LOCAL_NAME = '*default*';

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

// The name of a member accessed with a dot, like `x` in `ns.x`, but not of a computed member, like
// `ns['x']`, or of a private field
function staticMemberNameOf(expression: MemberExpression): string | undefined {
  return !expression.computed && expression.property.type === 'Identifier'
    ? expression.property.name
    : undefined;
}

// Whether a unary operator is a sign, the only unary operators that resolve
function isSign(operator: UnaryOperator): operator is '-' | '+' {
  return operator === '-' || operator === '+';
}

// Applies a sign to a value, which converts it to a number like JS does, so that `-'5'` is `-5`.
// Values that are not numbers do not resolve: a class name would be `NaN`, and a namespace throws.
function signedValueOf(operator: '-' | '+', value: StaticValue | undefined): string | undefined {
  if (typeof value !== 'string') return;

  const number = Number(value);
  if (Number.isNaN(number)) return;

  return String(operator === '-' ? -number : number);
}

// The name of an identifier, or of a chain of members of one, like `ns.inner.x`, signed or not,
// like `-gap`, by which warnings refer to the interpolations that do not resolve
function referenceNameOf(expression: Expression): string | undefined {
  if (expression.type === 'Identifier') {
    return expression.name;
  }

  if (expression.type === 'UnaryExpression') {
    if (!isSign(expression.operator)) return;

    const argumentName = referenceNameOf(expression.argument);

    return argumentName === undefined ? undefined : `${expression.operator}${argumentName}`;
  }

  if (expression.type !== 'MemberExpression') {
    return;
  }

  const objectName = referenceNameOf(expression.object);
  const memberName = staticMemberNameOf(expression);

  return objectName === undefined || memberName === undefined
    ? undefined
    : `${objectName}.${memberName}`;
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
    // Only a `const` has a static value: a `let`/`var` may be reassigned,
    // and a `var` is `undefined` until its declaration has run.
    const isConst = variableDeclarationKinds.at(-1) === 'const';

    // Record the initializer of a `const`, resolved on demand, or an unknown
    // value: either way, the binding shadows outer variables
    targetScope.identifiers.set(localName, isConst && node.init !== null ? node.init : undefined);

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
   * The modules whose CSS interpolates values exported by each module.
   *
   * Key: module ID, Value: IDs of the modules interpolating its values
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
    const exportedLocalNames = new Map<string, string>();

    // Collect the imports and exports from the top-level statements. The parse result's module
    // record lists them too, but converting it to JS objects takes longer than this loop, and
    // `SCOPE_VISITOR` would also visit the declarations nested in TypeScript namespaces.
    for (const statement of program.body) {
      if (statement.type === 'ImportDeclaration') {
        const source = statement.source.value;

        for (const specifier of statement.specifiers) {
          rootScope.identifiers.set(
            specifier.local.name,
            specifier.type === 'ImportNamespaceSpecifier'
              ? { type: 'NamespaceImport', source }
              : {
                  type: 'ImportBinding',
                  source,
                  imported:
                    specifier.type === 'ImportSpecifier' ? nameOf(specifier.imported) : 'default',
                },
          );
        }
      } else if (statement.type === 'ExportNamedDeclaration') {
        // TODO: handle re-exports
        if (statement.source !== null) continue;

        for (const specifier of statement.specifiers) {
          exportedLocalNames.set(nameOf(specifier.exported), nameOf(specifier.local));
        }

        // Only variables can be bound to static values, not functions or classes
        if (statement.declaration?.type === 'VariableDeclaration') {
          for (const { id } of statement.declaration.declarations) {
            if (id.type === 'Identifier') {
              exportedLocalNames.set(id.name, id.name);
            }
          }
        }
      } else if (statement.type === 'ExportDefaultDeclaration') {
        // Bind the exported value, unless it is a TypeScript interface, which has none
        if (statement.declaration.type !== 'TSInterfaceDeclaration') {
          rootScope.identifiers.set(DEFAULT_EXPORT_LOCAL_NAME, statement.declaration);
          exportedLocalNames.set('default', DEFAULT_EXPORT_LOCAL_NAME);
        }
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
      exportedLocalNames,
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

  async function readParsedFile(
    context: TransformPluginContext,
    filePath: string,
  ): Promise<ParsedFileInfo> {
    return parseFile(filePath, await context.fs.readFile(filePath, { encoding: 'utf8' }));
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
    cssContent: string;
    stylesheetDependencies: Set<string>;
  }> {
    // Parse the code being transformed, as other plugins may have changed it since it was read
    // from disk, and share the parse with the transforms that interpolate its values
    const parsedInfo = parseFile(filePath, code, parseLangOf(meta.moduleType));
    parsedFileInfoCache.set(filePath, parsedInfo);
    const { declarations } = parsedInfo;

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
    const bindingValues = new Map<
      Expression | ImportBinding | NamespaceImport,
      StaticValue | undefined
    >();

    // The modules that interpolated values are imported from, keyed by importer and import
    // source, so that each one is resolved, loaded, and parsed once per transform
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

    async function resolveImportedModule(source: string, importer: string) {
      // Resolve the import path relative to the importer
      const resolvedId = await context.resolve(source, importer);
      if (resolvedId == null) return;

      const { id } = resolvedId;

      // Record the dependency so that editing the imported module updates the transformed one
      let dependents = dependentsPerFile.get(id);

      if (dependents === undefined) {
        dependents = new Set();
        dependentsPerFile.set(id, dependents);
      }

      dependents.add(filePath);

      // Wait for the imported module's transform, which registers the stylesheet that
      // `resolveMember` imports. Vite's dev server does not transform modules loaded this way,
      // so there the stylesheet is only imported once that module has been transformed.
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

    // Statically evaluates an expression of a file, like an interpolation or the initializer of a
    // `const`, to its value: a string or number literal, an identifier bound to such a value, to a
    // class name, or to the namespace of a module, in the file or imported, a member of such a
    // namespace (`ns.x`), or any of these numbers, signed (`-5`, `-gap`, `+ns.x`). The value is
    // only returned as a promise when it is read through an import or a member.
    function resolveValue(
      expression: Expression,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): MaybePromise<StaticValue | undefined> {
      if (expression.type === 'Literal') {
        if (typeof expression.value === 'string' || typeof expression.value === 'number') {
          return String(expression.value);
        }
        return;
      }

      if (expression.type === 'UnaryExpression') {
        const { operator } = expression;
        if (!isSign(operator)) return;

        const value = resolveValue(expression.argument, scope, fileInfo);

        return value instanceof Promise
          ? value.then((resolvedValue) => signedValueOf(operator, resolvedValue))
          : signedValueOf(operator, value);
      }

      if (expression.type === 'MemberExpression') {
        const name = staticMemberNameOf(expression);
        if (name === undefined) return;

        return resolveMember(resolveValue(expression.object, scope, fileInfo), name);
      }

      if (expression.type !== 'Identifier') {
        return;
      }

      // Walk up the scope chain to find the identifier, imports included
      const bindingScope = findBindingScope(expression.name, scope);

      if (bindingScope === undefined) {
        return;
      }

      return resolveBinding(expression.name, bindingScope, fileInfo);
    }

    // Resolves the binding `name` declared in `scope`: a `const` takes the class name of its css``
    // template or the value of its initializer, a namespace import the namespace of its module,
    // and another import the value that its module exports. Other bindings have unknown values
    // (like function params), which stops the lookup and signals "can't resolve". It is not
    // async, as returning every binding as a promise measurably slows down builds with many named
    // imports.
    function resolveBinding(
      name: string,
      scope: Scope,
      fileInfo: ParsedFileInfo,
    ): MaybePromise<StaticValue | undefined> {
      const binding = scope.identifiers.get(name);

      if (binding === undefined) {
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
          ? resolveMember(loadImportedModule(binding.source, fileInfo.filePath), binding.imported)
          : binding.type === 'NamespaceImport'
            ? loadImportedModule(binding.source, fileInfo.filePath)
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

    // Resolves the member `name` of a value, which only the namespaces of modules have: the value
    // of the binding that the module exports by that name, which can itself be an import. It is
    // async, as returning members without a promise once their namespace is resolved is not
    // measurably faster.
    async function resolveMember(
      object: MaybePromise<StaticValue | undefined>,
      name: string,
    ): Promise<StaticValue | undefined> {
      const namespace = await object;
      if (typeof namespace !== 'object') return;

      const localName = namespace.exportedLocalNames.get(name);
      if (localName === undefined) return;

      const value = await resolveBinding(localName, namespace.rootScope, namespace);

      // Import the stylesheet of that module ahead of this module's own when the value is a
      // string, as it may be one of its class names
      if (typeof value === 'string') {
        const stylesheetImport = stylesheetImportPerFile.get(namespace.filePath);

        if (stylesheetImport !== undefined) {
          stylesheetDependencies.add(stylesheetImport);
        }
      }

      return value;
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

          // Only strings can be interpolated, not namespaces
          if (typeof resolvedValue !== 'string') {
            const name = referenceNameOf(expression);

            if (name !== undefined) {
              // Cannot resolve — skip this entire css`` block
              context.warn(
                {
                  pluginCode: 'UNRESOLVED_INTERPOLATION',
                  message: `skipped CSS extraction — could not resolve "${name}" to a static string or number`,
                },
                expression.start,
              );
            } else {
              // Complex expression — skip this entire css`` block
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

      for (const dependentId of dependents) {
        for (const id of [dependentId, ...(dependentsPerFile.get(dependentId) ?? [])]) {
          for (const moduleNode of this.environment.moduleGraph.getModulesByFile(id) ?? []) {
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
        ECIJ_IMPORT_REGEX.test(sourceCode) ? false : undefined,
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
        // Skip files that do not import from 'ecij' before the handler is called
        code: ECIJ_IMPORT_REGEX,
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

          let importStatements = '';

          // Import the stylesheets of the modules whose class names were interpolated into
          // the CSS above, ahead of this module's own. These statements are prepended to the
          // file, so leaving them out would emit this module's CSS before the CSS it
          // references, inverting the cascade.
          for (const id of stylesheetDependencies) {
            importStatements += `import ${JSON.stringify(id)};\n`;
          }

          // Use JSON.stringify to properly escape the module ID,
          // including \ separators on Windows.
          importStatements += `import ${JSON.stringify(cssModuleId)};\n`;

          // Add side-effect/CSS module imports at the top of the file.
          magicString.prepend(importStatements);
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
