import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';

import type {
  AssignmentTargetMaybeDefault,
  BindingPattern,
  BlockStatement,
  Expression,
  ParamPattern,
  TaggedTemplateExpression,
} from '@oxc-project/types';
import { RolldownMagicString, type Plugin, type TransformPluginContext } from 'rolldown';
import { makeIdFiltersToMatchWithQuery } from 'rolldown/filter';
import { parseSync, Visitor } from 'rolldown/utils';

export interface Configuration {
  /**
   * Include patterns for files to process.
   * Can be a string, RegExp, or array of strings/RegExp.
   * @default /\.[cm]?[jt]sx?$/
   */
  include?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Exclude patterns for files to skip.
   * Can be a string, RegExp, or array of strings/RegExp.
   * @default [/\/node_modules\//, /\.d\.ts$/]
   */
  exclude?: string | RegExp | ReadonlyArray<string | RegExp> | undefined | null;

  /**
   * Prefix for generated CSS class names.
   * Should not be empty, as generated hashes may start with a digit, resulting in invalid CSS class names.
   * @default 'css-'
   */
  classPrefix?: string | undefined | null;
}

interface Scope {
  // undefined value means "declared but value unknown at build time" (e.g. function params)
  identifiers: Map<string, string | undefined>;
  parent: Scope | null;
  // true for function/module/static-block scopes (where `var` bindings land)
  isFunctionScope: boolean;
}

interface Declaration {
  className: string;
  node: TaggedTemplateExpression;
  hasInterpolations: boolean;
  // Scope the template appears in, where its interpolations are resolved
  scope: Scope;
}

// A css`` template found while visiting a file. Whether its tag is shadowed is
// only decided once the visit completes and every scope is fully populated.
interface CssTagCandidate {
  // Variable the template is assigned to, if any
  localName: string | undefined;
  node: TaggedTemplateExpression;
  // Local name of the tag, a binding of ecij's `css`
  tagName: string;
  // Scope the template appears in, where the tag and the interpolations are resolved
  scope: Scope;
  // Scope `localName` is bound in (the function scope for `var` declarations)
  bindingScope: Scope;
  // Export name when the template is an `export default`
  exportedAs: string | undefined;
}

type ImportedIdentifier =
  // `import { x } from 'mod'` (`imported` is `'default'` for default imports)
  | { kind: 'named'; source: string; imported: string }
  // `import * as ns from 'mod'`
  | { kind: 'namespace'; source: string };

type ExportRecord =
  // Locally-resolved literal/css class. `fromCss` marks css`` class names,
  // which are only usable once their declaration was actually extracted.
  // `localName` identifies the underlying binding (per ECMA-262, two export
  // aliases of the same binding are NOT ambiguous when reached via `export *`).
  | { kind: 'value'; value: string; fromCss: boolean; localName: string | undefined }
  // `export { x } from 'mod'`, including default-as-name and name-as-default
  | { kind: 'reexport'; source: string; imported: string }
  // `export * as ns from 'mod'`
  | { kind: 'namespace-reexport'; source: string }
  // Explicit export whose value is not statically known. Recorded so explicit
  // exports still shadow `export *` sources, per ESM precedence.
  | { kind: 'unresolved'; localName: string | undefined };

interface ParsedFileInfo {
  readonly declarations: readonly Declaration[];
  readonly importedIdentifiers: ReadonlyMap<string, ImportedIdentifier>;
  readonly exportNameToValueMap: ReadonlyMap<string, ExportRecord>;
  // Sources from `export * from 'mod'` (looked up when a name is missing from exportNameToValueMap)
  readonly exportStarSources: readonly string[];
}

// allow .js, .cjs, .mjs, .ts, .cts, .mts, .jsx, .tsx files
const JS_TS_FILE_REGEX = /\.[cm]?[jt]sx?$/;

// disallow /node_modules/ and .d.ts files
const NODE_MODULES_REGEX = /\/node_modules\//;
const D_TS_FILE_REGEX = /\.d\.ts$/;

// Get the project root directory
const PROJECT_ROOT = cwd();

function hashText(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 8);
}

// Remove query parameters from a module ID, e.g. `/src/a.ts?used` -> `/src/a.ts`
function stripQuery(id: string): string {
  const queryIndex = id.indexOf('?');
  return queryIndex === -1 ? id : id.slice(0, queryIndex);
}

// Unwraps parentheses and TypeScript type-assertion wrappers,
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

// Statically evaluates an expression to its string value:
// string/number literals and signed number literals (`-5`, `+5`).
function resolveStaticExpression(expression: Expression): string | undefined {
  expression = unwrapExpression(expression);

  switch (expression.type) {
    case 'Literal':
      if (typeof expression.value === 'string' || typeof expression.value === 'number') {
        return String(expression.value);
      }
      break;

    case 'UnaryExpression': {
      const argument = unwrapExpression(expression.argument);
      if (
        (expression.operator === '-' || expression.operator === '+') &&
        argument.type === 'Literal' &&
        typeof argument.value === 'number'
      ) {
        return String(expression.operator === '-' ? -argument.value : argument.value);
      }
      break;
    }
  }

  return undefined;
}

// Flattens `ns.inner.foo` into `['ns', 'inner', 'foo']`. Returns undefined
// for anything other than a plain (non-computed, non-optional) identifier
// chain; parens/TS assertion wrappers around any segment are unwrapped.
function flattenMemberExpressionPath(expression: Expression): string[] | undefined {
  const names: string[] = [];
  let current = unwrapExpression(expression);

  while (current.type === 'MemberExpression') {
    if (current.computed || current.optional || current.property.type !== 'Identifier') {
      return undefined;
    }
    names.unshift(current.property.name);
    current = unwrapExpression(current.object);
  }

  if (current.type !== 'Identifier') {
    return undefined;
  }

  names.unshift(current.name);
  return names;
}

// Calls `callback` with every binding an assignment target writes to:
// `x = …`, `x++`, `[x, ...rest] = …`, `({ a: x = 1 } = …)`. Member expressions
// do not rebind anything and are ignored.
function forEachAssignedName(
  target: AssignmentTargetMaybeDefault,
  callback: (name: string) => void,
): void {
  switch (target.type) {
    case 'Identifier':
      callback(target.name);
      break;
    case 'ArrayPattern':
      for (const element of target.elements) {
        if (element === null) continue;
        forEachAssignedName(element.type === 'RestElement' ? element.argument : element, callback);
      }
      break;
    case 'ObjectPattern':
      for (const property of target.properties) {
        forEachAssignedName(
          property.type === 'RestElement' ? property.argument : property.value,
          callback,
        );
      }
      break;
    case 'AssignmentPattern':
      forEachAssignedName(target.left, callback);
      break;
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSNonNullExpression':
    case 'TSTypeAssertion': {
      // `(x as T) = …`
      const expression = unwrapExpression(target.expression);
      if (expression.type === 'Identifier') {
        callback(expression.name);
      }
      break;
    }
  }
}

// True if `name` is bound anywhere along the scope chain (i.e. shadows imports).
function isBoundInScopeChain(name: string, scope: Scope): boolean {
  for (let current: Scope | null = scope; current !== null; current = current.parent) {
    if (current.identifiers.has(name)) return true;
  }
  return false;
}

export function ecij(configuration?: Configuration | undefined | null): Plugin {
  const include = configuration?.include ?? JS_TS_FILE_REGEX;
  const exclude = configuration?.exclude ?? [NODE_MODULES_REGEX, D_TS_FILE_REGEX];
  const classPrefix = configuration?.classPrefix ?? 'css-';

  const parsedFileInfoCache = new Map<string, ParsedFileInfo>();

  // Class names that were actually extracted, per file. A css`` class name is
  // only safe to inline elsewhere once its rule made it into a stylesheet.
  const extractedClassesPerFile = new Map<string, Set<string>>();

  // Which module load each in-flight transform is currently awaiting
  // (transform id -> awaited module ids, reference-counted). Used to detect
  // when awaiting a `context.load` would close a wait cycle and deadlock the
  // build (a load only settles once the module's transform returns).
  const pendingLoads = new Map<string, Map<string, number>>();

  function addPendingLoad(from: string, to: string) {
    let targets = pendingLoads.get(from);
    if (targets === undefined) {
      targets = new Map();
      pendingLoads.set(from, targets);
    }
    targets.set(to, (targets.get(to) ?? 0) + 1);
  }

  function removePendingLoad(from: string, to: string) {
    const targets = pendingLoads.get(from);
    const count = targets?.get(to);
    if (targets === undefined || count === undefined) return;
    if (count > 1) {
      targets.set(to, count - 1);
    } else {
      targets.delete(to);
      if (targets.size === 0) {
        pendingLoads.delete(from);
      }
    }
  }

  // Map to store generated CSS module IDs for each source file, used to mark modules as having side effects
  // Key: module id, Value: CSS module id
  const stylesheetImportPerFile = new Map<string, string>();

  // Map to store extracted CSS content per source file
  // Key: virtual module ID, Value: css content
  const extractedCssPerFile = new Map<string, string>();

  /**
   * Parses a file and extracts all relevant information in a single pass
   */
  async function parseFile(
    context: TransformPluginContext,
    filePath: string,
    code?: string,
  ): Promise<ParsedFileInfo> {
    // The code loaded from `readFile` might not be identical
    // to the code passed in after it has been processed by other plugins,
    // as such we cannot rely on the position of declarations being the same,
    // and the new code should be parsed.
    if (code === undefined && parsedFileInfoCache.has(filePath)) {
      return parsedFileInfoCache.get(filePath)!;
    }

    // Convert absolute path to project-relative path and normalize to Unix format
    // to ensure consistent hashes across different build environments (Windows/Unix)
    const relativePath = relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');

    // Prefer the module graph's copy of the source. Note `ModuleInfo.code` is
    // the *post-transform* code — acceptable here because only exports/values
    // are read from these parses (positions are never used across files), and
    // it also covers virtual modules that have no file on disk. Fall back to
    // the disk for modules that haven't entered the graph yet; an unreadable
    // module (e.g. virtual id) parses as empty, degrading to an
    // UNRESOLVED_INTERPOLATION warning at the consumer.
    const sourceText =
      code ??
      context.getModuleInfo(filePath)?.code ??
      (await context.fs.readFile(filePath, { encoding: 'utf8' }).catch(() => ''));

    const parseResult = parseSync(filePath, sourceText);
    const declarations: Declaration[] = [];
    const importedIdentifiers = new Map<string, ImportedIdentifier>();
    const exportNameToValueMap = new Map<string, ExportRecord>();
    const exportStarSources: string[] = [];
    // Multiple exported names can reference the same local binding
    // (e.g. `export { foo, foo as bar }`).
    const localNameToExportedNamesMap = new Map<string, string[]>();
    const processedTaggedTemplateExpressions = new Set<TaggedTemplateExpression>();
    // Local bindings of `css` imported from 'ecij' (including aliases)
    const cssTagNames = new Set<string>();
    // Spans of default-import local bindings: oxc normalizes
    // `import foo from 'mod'; export { foo };` into a re-export entry whose
    // importName is the *local* binding (carrying its span) instead of
    // 'default' — these spans let us map such entries back to the default.
    const defaultImportLocalSpans = new Set<string>();

    // Scope tracking: root scope for module-level declarations
    const rootScope: Scope = { identifiers: new Map(), parent: null, isFunctionScope: true };
    let currentScope = rootScope;
    // Kinds of the `VariableDeclaration`s being visited, innermost last. An
    // initializer can itself contain declarations (e.g. a function body), so a
    // single slot would be clobbered before the next declarator is visited.
    const variableDeclarationKinds: string[] = [];
    // Bindings written to after their declaration (`x = …`, `x++`,
    // `for (x of …)`), with the scope the write appears in. A reassigned
    // binding has no static value; applied once the visit completes so writes
    // preceding a hoisted declaration are covered too.
    const reassignments: Array<{ name: string; scope: Scope }> = [];

    function recordReassignment(name: string) {
      reassignments.push({ name, scope: currentScope });
    }

    const parsedInfo: ParsedFileInfo = {
      declarations,
      importedIdentifiers,
      exportNameToValueMap,
      exportStarSources,
    };

    parsedFileInfoCache.set(filePath, parsedInfo);

    // Collect imports
    for (const staticImport of parseResult.module.staticImports) {
      const source = staticImport.moduleRequest.value;

      for (const entry of staticImport.entries) {
        // Skip TypeScript type-only imports
        if (entry.isType) continue;

        const localName = entry.localName.value;

        switch (entry.importName.kind) {
          case 'Name': {
            // `import { foo } from 'mod'` / `import { foo as bar } from 'mod'`
            const imported = entry.importName.name!;

            if (source === 'ecij' && imported === 'css') {
              cssTagNames.add(localName);
            }

            importedIdentifiers.set(localName, { kind: 'named', source, imported });
            break;
          }
          case 'Default': {
            // `import foo from 'mod'`
            defaultImportLocalSpans.add(`${entry.localName.start}:${entry.localName.end}`);
            importedIdentifiers.set(localName, { kind: 'named', source, imported: 'default' });
            break;
          }
          case 'NamespaceObject': {
            // `import * as ns from 'mod'`
            importedIdentifiers.set(localName, { kind: 'namespace', source });
            break;
          }
        }
      }
    }

    // Collect exports
    for (const staticExport of parseResult.module.staticExports) {
      for (const entry of staticExport.entries) {
        // Skip TypeScript type-only exports
        if (entry.isType) continue;

        const moduleRequest = entry.moduleRequest?.value;

        // Re-exports (have a moduleRequest)
        if (moduleRequest !== undefined) {
          switch (entry.importName.kind) {
            case 'Name': {
              // `export { foo } from 'mod'`, `export { foo as bar } from 'mod'`,
              // `export { default as foo } from 'mod'`, `export { foo as default } from 'mod'`
              const exportedName =
                entry.exportName.kind === 'Default' ? 'default' : entry.exportName.name!;
              // `import foo from 'mod'; export { foo };` entries point at the
              // local default-import binding — map them back to 'default'
              // (see `defaultImportLocalSpans`).
              const imported = defaultImportLocalSpans.has(
                `${entry.importName.start}:${entry.importName.end}`,
              )
                ? 'default'
                : entry.importName.name!;
              exportNameToValueMap.set(exportedName, {
                kind: 'reexport',
                source: moduleRequest,
                imported,
              });
              break;
            }
            case 'AllButDefault': {
              // `export * from 'mod'` — does not include the default export
              exportStarSources.push(moduleRequest);
              break;
            }
            case 'All': {
              // `export * as ns from 'mod'`
              const exportedName = entry.exportName.name!;
              exportNameToValueMap.set(exportedName, {
                kind: 'namespace-reexport',
                source: moduleRequest,
              });
              break;
            }
          }
          continue;
        }

        // Local exports (no moduleRequest)
        // `localName.kind === 'Default'` covers `export default <local-binding>`,
        // `localName.kind === 'Name'` covers `export { x }` and `export { x as y }`.
        if (
          entry.exportName.kind !== 'None' &&
          (entry.localName.kind === 'Name' || entry.localName.kind === 'Default') &&
          entry.localName.name !== null
        ) {
          const localName = entry.localName.name;
          // `entry.exportName.name` is null when `kind === 'Default'` (the name "default"
          // is implicit in `export default <local>`).
          const exportedName =
            entry.exportName.kind === 'Default' ? 'default' : entry.exportName.name!;

          // If the local name is actually an imported identifier, the export is
          // a transitive re-export (`import { foo } from 'mod'; export default foo;`).
          const importEntry = importedIdentifiers.get(localName);
          if (importEntry !== undefined) {
            if (importEntry.kind === 'named') {
              exportNameToValueMap.set(exportedName, {
                kind: 'reexport',
                source: importEntry.source,
                imported: importEntry.imported,
              });
            } else {
              exportNameToValueMap.set(exportedName, {
                kind: 'namespace-reexport',
                source: importEntry.source,
              });
            }
            continue;
          }

          // Map a locally-bound name to its exported names so we can record values
          // in `exportNameToValueMap` once the binding's value is known.
          const existing = localNameToExportedNamesMap.get(localName);
          if (existing === undefined) {
            localNameToExportedNamesMap.set(localName, [exportedName]);
          } else {
            existing.push(exportedName);
          }
        }
      }
    }

    function recordIdentifierWithValue(
      localName: string,
      value: string,
      scope = currentScope,
      fromCss = false,
    ) {
      scope.identifiers.set(localName, value);

      // Only record exports for module-level (root scope) declarations
      if (scope === rootScope && localNameToExportedNamesMap.has(localName)) {
        for (const exportedName of localNameToExportedNamesMap.get(localName)!) {
          exportNameToValueMap.set(exportedName, { kind: 'value', value, fromCss, localName });
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
    function addCssTagCandidate(
      localName: string | undefined,
      node: TaggedTemplateExpression,
      bindingScope = currentScope,
      exportedAs?: string | undefined,
    ) {
      if (!(node.tag.type === 'Identifier' && cssTagNames.has(node.tag.name))) {
        return;
      }

      processedTaggedTemplateExpressions.add(node);
      cssTagCandidates.push({
        localName,
        node,
        tagName: node.tag.name,
        scope: currentScope,
        bindingScope,
        exportedAs,
      });
    }

    function extractCssTagCandidate({
      localName,
      node,
      tagName,
      scope,
      bindingScope,
      exportedAs,
    }: CssTagCandidate) {
      // A local binding shadowing the imported tag means this is not the ecij tag
      if (isBoundInScopeChain(tagName, scope)) {
        return;
      }

      const index = declarations.length;

      // Create a hash from the relative file path, index,
      // and identifier for consistency across builds.
      // The index is always used to avoid collisions with other variables
      // with the same name in the same file.
      const hash = hashText(`${relativePath}:${index}:${localName ?? exportedAs}`);

      const className = `${classPrefix}${hash}`;

      declarations.push({
        className,
        node,
        hasInterpolations: node.quasi.expressions.length !== 0,
        scope,
      });

      // Record generated class names for css declarations
      if (localName !== undefined) {
        recordIdentifierWithValue(localName, className, bindingScope, true);
      } else if (exportedAs !== undefined && scope === rootScope) {
        // `export default css\`...\`` has no local name but is reachable
        // via the `default` export.
        exportNameToValueMap.set(exportedAs, {
          kind: 'value',
          value: className,
          fromCss: true,
          localName: undefined,
        });
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

      // For statements: create a scope for loop variable declarations,
      // merge with the body's BlockStatement
      ForStatement(node) {
        pushScope();
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ForStatement:exit': popScope,

      ForInStatement(node) {
        pushScope();
        if (node.left.type !== 'VariableDeclaration') {
          forEachAssignedName(node.left, recordReassignment);
        }
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ForInStatement:exit': popScope,

      ForOfStatement(node) {
        pushScope();
        if (node.left.type !== 'VariableDeclaration') {
          forEachAssignedName(node.left, recordReassignment);
        }
        if (node.body.type === 'BlockStatement') {
          skippedBlockStatements.add(node.body);
        }
      },
      'ForOfStatement:exit': popScope,

      // Switch statements create a scope for case-level declarations.
      // SwitchCase consequent is Array<Statement>, not a BlockStatement, so no merge needed.
      SwitchStatement() {
        pushScope();
      },
      'SwitchStatement:exit': popScope,

      // Catch clauses: create a scope for the catch parameter, merge with body BlockStatement
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

      // Static blocks have their own scope (type is "StaticBlock", not "BlockStatement")
      // They are function-scoped for `var` declarations.
      StaticBlock() {
        pushScope(true);
      },
      'StaticBlock:exit': popScope,

      AssignmentExpression(node) {
        forEachAssignedName(node.left, recordReassignment);
      },

      UpdateExpression(node) {
        forEachAssignedName(node.argument, recordReassignment);
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
        const init = node.init == null ? undefined : unwrapExpression(node.init);

        if (init !== undefined) {
          if (init.type === 'TaggedTemplateExpression') {
            // Bound as unknown below; a css`` candidate that gets extracted
            // replaces it with the generated class name.
            addCssTagCandidate(localName, init, targetScope);
          } else {
            const value = resolveStaticExpression(init);
            if (value !== undefined) {
              recordIdentifierWithValue(localName, value, targetScope);
              return;
            }
          }
        }

        // Record as unknown value so it shadows outer variables
        targetScope.identifiers.set(localName, undefined);
      },

      TaggedTemplateExpression(node) {
        if (!processedTaggedTemplateExpressions.has(node)) {
          // No variable name for inline expressions
          addCssTagCandidate(undefined, node);
        }
      },

      // `export default <expr>` — handle css tagged templates and static
      // string/number expressions. Identifiers reach the default export through
      // the staticExports loop above (which records `default` in
      // `localNameToExportedNamesMap`); function/class declarations have no
      // static value and are skipped by both branches.
      ExportDefaultDeclaration(node) {
        const declaration =
          node.declaration.type === 'FunctionDeclaration' ||
          node.declaration.type === 'ClassDeclaration' ||
          node.declaration.type === 'TSInterfaceDeclaration'
            ? undefined
            : unwrapExpression(node.declaration);
        if (declaration === undefined) return;

        if (declaration.type === 'TaggedTemplateExpression') {
          addCssTagCandidate(undefined, declaration, currentScope, 'default');
          return;
        }

        const value = resolveStaticExpression(declaration);
        if (value !== undefined) {
          exportNameToValueMap.set('default', {
            kind: 'value',
            value,
            fromCss: false,
            localName: undefined,
          });
        }
      },
    });

    visitor.visit(parseResult.program);

    // Every scope is populated now, so tag shadowing can be decided
    for (const candidate of cssTagCandidates) {
      extractCssTagCandidate(candidate);
    }

    // A reassigned binding has no static value wherever it was declared, and
    // neither do its exports.
    for (const { name, scope } of reassignments) {
      for (let current: Scope | null = scope; current !== null; current = current.parent) {
        if (!current.identifiers.has(name)) continue;
        current.identifiers.set(name, undefined);
        if (current === rootScope) {
          for (const exportedName of localNameToExportedNamesMap.get(name) ?? []) {
            exportNameToValueMap.set(exportedName, { kind: 'unresolved', localName: name });
          }
        }
        break;
      }
    }

    // Explicit exports that never received a static value must still shadow
    // `export *` sources (per ESM, explicit exports win over star re-exports),
    // so mark them as present-but-unresolvable.
    for (const [localName, exportedNames] of localNameToExportedNamesMap) {
      for (const exportedName of exportedNames) {
        if (!exportNameToValueMap.has(exportedName)) {
          exportNameToValueMap.set(exportedName, { kind: 'unresolved', localName });
        }
      }
    }

    return parsedInfo;
  }

  /**
   * Extracts CSS from template literals in the source code using AST parsing
   * Supports interpolations of strings and numbers (both local and imported)
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

    // True if awaiting `context.load(targetFilePath)` can never settle: the
    // target is this module, or its transform is (transitively) awaiting a
    // load of this module.
    function loadWouldDeadlock(targetFilePath: string): boolean {
      const queue = [targetFilePath];
      const seen = new Set<string>();

      while (queue.length !== 0) {
        const current = queue.pop()!;
        if (current === filePath) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        const targets = pendingLoads.get(current);
        if (targets !== undefined) {
          queue.push(...targets.keys());
        }
      }

      return false;
    }

    // Resolved import specifiers by importer and source. A file with several
    // interpolations from the same module would otherwise resolve and load it
    // once per interpolation, and again on every deferred retry.
    const resolvedImports = new Map<string, Promise<string | undefined>>();

    // Resolve a `source` import specifier relative to `importer` and ensure
    // the target module has been parsed (so its caches are populated).
    function resolveImportedFile(source: string, importer: string): Promise<string | undefined> {
      const key = `${importer}\0${source}`;
      let resolved = resolvedImports.get(key);
      if (resolved === undefined) {
        resolved = loadImportedFile(source, importer);
        resolvedImports.set(key, resolved);
      }
      return resolved;
    }

    async function loadImportedFile(source: string, importer: string): Promise<string | undefined> {
      const resolvedId = await context.resolve(source, importer);
      // External modules cannot be parsed for static values
      if (resolvedId == null || resolvedId.external !== false) return undefined;

      const targetFilePath = stripQuery(resolvedId.id);

      // Re-run this file's transform when the dependency changes in watch
      // mode, since its values are baked into this file's output
      if (!targetFilePath.startsWith('\0')) {
        context.addWatchFile(targetFilePath);
      }

      // Loading a module that is (transitively) awaiting this module's own
      // transform would deadlock — e.g. a barrel re-exporting the file
      // currently being transformed. Its parse info is served from the cache
      // (or disk) instead. Loads of independent in-flight modules are awaited
      // normally so their extraction results are complete before use.
      if (loadWouldDeadlock(targetFilePath)) {
        return targetFilePath;
      }

      addPendingLoad(filePath, targetFilePath);
      try {
        // populate the cache for the imported file
        await context.load(resolvedId);
      } finally {
        removePendingLoad(filePath, targetFilePath);
      }

      return targetFilePath;
    }

    // A statically-resolved export: a concrete value, a module namespace
    // (`export * as ns from 'mod'`), or a name that exists but has no static
    // value. `origin` identifies the terminal binding, so the `export *`
    // ambiguity check can tell two paths to the same binding apart from
    // genuinely conflicting ones. `files` lists the modules traversed to reach
    // the value; their stylesheets must be pulled into the consumer.
    type ResolvedExport =
      | { kind: 'value'; value: string; origin: string; files: readonly string[] }
      | { kind: 'namespace'; filePath: string; files: readonly string[] }
      | { kind: 'unresolved'; origin: string };

    // Resolve `exportName` from `targetFilePath`, following re-export chains
    // (`export { x } from 'mod'`) and `export *` aggregations.
    async function resolveExportTarget(
      targetFilePath: string,
      exportName: string,
      visited: Set<string>,
    ): Promise<ResolvedExport | undefined> {
      // Guard against cyclic re-export chains
      const cacheKey = `${targetFilePath}::${exportName}`;
      if (visited.has(cacheKey)) return undefined;
      visited.add(cacheKey);

      const { exportNameToValueMap, exportStarSources } = await parseFile(context, targetFilePath);

      const record = exportNameToValueMap.get(exportName);
      if (record !== undefined) {
        // Key the binding by its local name when known: two export aliases of
        // the same binding reached through different `export *` paths are not
        // ambiguous per ECMA-262 ResolveExport.
        const origin =
          record.kind === 'value' || record.kind === 'unresolved'
            ? `${targetFilePath}::${record.localName ?? exportName}`
            : cacheKey;

        switch (record.kind) {
          case 'value':
            // css`` class names are only usable if their declaration was
            // actually extracted; a skipped (unresolvable interpolations) or
            // filtered-out (e.g. node_modules) declaration would leave the
            // class without a rule in the emitted stylesheets.
            if (record.fromCss && !extractedClassesPerFile.get(targetFilePath)?.has(record.value)) {
              return { kind: 'unresolved', origin };
            }
            return {
              kind: 'value',
              value: record.value,
              origin,
              files: [targetFilePath],
            };
          case 'reexport': {
            const nextFilePath = await resolveImportedFile(record.source, targetFilePath);
            if (nextFilePath === undefined) return undefined;
            const target = await resolveExportTarget(nextFilePath, record.imported, visited);
            if (target === undefined || target.kind === 'unresolved') return target;
            return { ...target, files: [targetFilePath, ...target.files] };
          }
          case 'namespace-reexport': {
            const namespaceFilePath = await resolveImportedFile(record.source, targetFilePath);
            if (namespaceFilePath === undefined) return undefined;
            return { kind: 'namespace', filePath: namespaceFilePath, files: [targetFilePath] };
          }
          case 'unresolved':
            return { kind: 'unresolved', origin };
        }
      }

      // `export * from 'mod'` — excludes the default export. All sources are
      // probed: per ESM, a name provided by multiple star sources (through
      // different bindings) is ambiguous and not exported at all.
      if (exportName !== 'default') {
        const candidates = new Map<string, ResolvedExport>();

        for (const source of exportStarSources) {
          const nextFilePath = await resolveImportedFile(source, targetFilePath);
          if (nextFilePath === undefined) continue;
          const target = await resolveExportTarget(nextFilePath, exportName, visited);
          if (target === undefined) continue;
          const targetKey = target.kind === 'namespace' ? `ns:${target.filePath}` : target.origin;
          candidates.set(targetKey, target);
        }

        if (candidates.size === 1) {
          const target = candidates.values().next().value!;
          if (target.kind === 'unresolved') return target;
          return { ...target, files: [targetFilePath, ...target.files] };
        }
        if (candidates.size > 1) {
          // Ambiguous `export *` name
          return { kind: 'unresolved', origin: cacheKey };
        }
      }

      return undefined;
    }

    // Record the stylesheets of `files` into `dependencies`
    function addStylesheetDependencies(files: readonly string[], dependencies: Set<string>) {
      for (const file of files) {
        const stylesheet = stylesheetImportPerFile.get(file);
        if (stylesheet !== undefined) {
          dependencies.add(stylesheet);
        }
      }
    }

    // Resolve `exportName` from `targetFilePath` to a static value. Stylesheet
    // dependencies are recorded only when resolution succeeds, so probing a
    // module that does not provide the value never drags its CSS in.
    async function resolveExportValue(
      targetFilePath: string,
      exportName: string,
      dependencies: Set<string>,
    ): Promise<string | undefined> {
      const target = await resolveExportTarget(targetFilePath, exportName, new Set());
      if (target === undefined || target.kind !== 'value') return undefined;

      addStylesheetDependencies(target.files, dependencies);
      return target.value;
    }

    // Helper to resolve a value from an identifier, walking up the scope chain
    async function resolveValue(
      identifierName: string,
      scope: Scope,
      dependencies: Set<string>,
    ): Promise<string | undefined> {
      if (scope.identifiers.has(identifierName)) {
        // May return undefined for declarations with unknown values (e.g. function params),
        // which stops the lookup and signals "can't resolve"
        return scope.identifiers.get(identifierName);
      }

      // Walk up the scope chain to find the identifier
      const { parent } = scope;
      if (parent !== null) {
        return resolveValue(identifierName, parent, dependencies);
      }

      // Check if it's an imported identifier
      const importEntry = importedIdentifiers.get(identifierName);
      if (importEntry === undefined) return undefined;

      // Namespace imports cannot be resolved to a single value here —
      // they need to be accessed via member expression (`ns.foo`).
      if (importEntry.kind === 'namespace') return undefined;

      const importedFilePath = await resolveImportedFile(importEntry.source, filePath);
      if (importedFilePath === undefined) return undefined;

      return resolveExportValue(importedFilePath, importEntry.imported, dependencies);
    }

    // Resolve `${ns.foo}` / `${ns.inner.foo}` member paths where the base
    // identifier is a namespace import (`import * as ns from 'mod'`) or a
    // named import that (transitively) resolves to a namespace re-export
    // (`export * as ns from 'mod'`).
    async function resolveMemberPath(
      names: readonly string[],
      scope: Scope,
      dependencies: Set<string>,
    ): Promise<string | undefined> {
      const namespaceName = names[0]!;

      // A local binding shadows the import
      if (isBoundInScopeChain(namespaceName, scope)) return undefined;

      const importEntry = importedIdentifiers.get(namespaceName);
      if (importEntry === undefined) return undefined;

      const importedFilePath = await resolveImportedFile(importEntry.source, filePath);
      if (importedFilePath === undefined) return undefined;

      const traversedFiles: string[] = [];
      let namespaceFilePath: string;

      if (importEntry.kind === 'namespace') {
        namespaceFilePath = importedFilePath;
      } else {
        // Named import — it must resolve to a namespace re-export
        const target = await resolveExportTarget(importedFilePath, importEntry.imported, new Set());
        if (target === undefined || target.kind !== 'namespace') return undefined;
        traversedFiles.push(...target.files);
        namespaceFilePath = target.filePath;
      }

      // Intermediate members must each resolve to a nested namespace
      // (`export * as inner from 'mod'`); the final member is the value.
      for (let i = 1; i < names.length - 1; i++) {
        const target = await resolveExportTarget(namespaceFilePath, names[i]!, new Set());
        if (target === undefined || target.kind !== 'namespace') return undefined;
        traversedFiles.push(...target.files);
        namespaceFilePath = target.filePath;
      }

      const target = await resolveExportTarget(
        namespaceFilePath,
        names[names.length - 1]!,
        new Set(),
      );
      if (target === undefined || target.kind !== 'value') return undefined;

      addStylesheetDependencies([...traversedFiles, ...target.files], dependencies);
      return target.value;
    }

    // Class names extracted from this file so far. Registered up front and
    // filled incrementally, so concurrent/cyclic resolutions of this module's
    // exports see classes as soon as their declarations are extracted.
    const extractedClasses = new Set<string>();
    extractedClassesPerFile.set(filePath, extractedClasses);

    // Helper to add a processed CSS declaration
    function addProcessedDeclaration(declaration: Declaration, cssContent: string) {
      const { className, node } = declaration;

      extractedClasses.add(className);

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

    // Class names generated for this file's own declarations — references to
    // them only resolve once the corresponding declaration is extracted.
    const ownClassNames = new Set(declarations.map(({ className }) => className));

    // Resolve all interpolations of one declaration.
    // - 'extracted': all resolved, declaration recorded
    // - 'deferred': blocked on a same-file class that is not extracted (yet);
    //   retried unless `finalAttempt`, in which case it warns and skips
    // - 'skipped': unresolvable, warning emitted
    async function processInterpolatedDeclaration(
      declaration: Declaration,
      finalAttempt: boolean,
    ): Promise<'extracted' | 'deferred' | 'skipped'> {
      const { quasis, expressions } = declaration.node.quasi;

      // Stylesheets of the modules the interpolations resolve through. They are
      // only committed once the declaration is extracted: a skipped declaration
      // is left untouched, so it must not pull in the stylesheets of modules it
      // merely probed.
      const dependencies = new Set<string>();
      let cssContent = '';

      for (let i = 0; i < quasis.length; i++) {
        cssContent += quasis[i]!.value.raw;

        if (i < expressions.length) {
          const expression = unwrapExpression(expressions[i]!);

          let resolvedValue = resolveStaticExpression(expression);

          if (resolvedValue === undefined) {
            const memberPath =
              expression.type === 'MemberExpression'
                ? flattenMemberExpressionPath(expression)
                : undefined;

            if (expression.type === 'Identifier') {
              resolvedValue = await resolveValue(expression.name, declaration.scope, dependencies);

              // A class name of a same-file declaration that has not been
              // extracted: defer in case it is a forward reference whose
              // declaration is still pending; once no progress can be made
              // it is a failed extraction and must not leak (no rule exists).
              if (
                resolvedValue !== undefined &&
                ownClassNames.has(resolvedValue) &&
                !extractedClasses.has(resolvedValue)
              ) {
                if (!finalAttempt) return 'deferred';
                resolvedValue = undefined;
              }

              if (resolvedValue === undefined) {
                // Cannot resolve - skip this entire css`` block
                context.warn(
                  {
                    pluginCode: 'UNRESOLVED_INTERPOLATION',
                    message: `skipped CSS extraction — could not resolve "${expression.name}" to a static string or number`,
                  },
                  expression.start,
                );
                return 'skipped';
              }
            } else if (memberPath !== undefined) {
              // Namespace member access: `${ns.foo}` / `${ns.inner.foo}`
              resolvedValue = await resolveMemberPath(memberPath, declaration.scope, dependencies);

              if (resolvedValue === undefined) {
                context.warn(
                  {
                    pluginCode: 'UNRESOLVED_INTERPOLATION',
                    message: `skipped CSS extraction — could not resolve "${memberPath.join('.')}" to a static string or number`,
                  },
                  expression.start,
                );
                return 'skipped';
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
              return 'skipped';
            }
          }

          cssContent += resolvedValue;
        }
      }

      addProcessedDeclaration(declaration, cssContent);
      for (const dependency of dependencies) {
        stylesheetDependencies.add(dependency);
      }
      return 'extracted';
    }

    // Pass 2: With interpolations using resolved local references.
    // Declarations blocked on same-file forward references are retried until
    // no further progress is made.
    let remaining = declarations.filter(({ hasInterpolations }) => hasInterpolations);

    while (remaining.length !== 0) {
      const deferred: Declaration[] = [];

      for (const declaration of remaining) {
        if ((await processInterpolatedDeclaration(declaration, false)) === 'deferred') {
          deferred.push(declaration);
        }
      }

      if (deferred.length === remaining.length) {
        // No progress — the deferred declarations are unresolvable
        for (const declaration of deferred) {
          await processInterpolatedDeclaration(declaration, true);
        }
        break;
      }

      remaining = deferred;
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

    for (const { start, end, className } of replacements) {
      magicString.overwrite(start, end, `'${className}'`);
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

  return {
    name: 'ecij',

    buildEnd() {
      // Clear caches between builds
      parsedFileInfoCache.clear();
      extractedClassesPerFile.clear();
      pendingLoads.clear();
      stylesheetImportPerFile.clear();
      extractedCssPerFile.clear();
    },

    watchChange(id) {
      // Evict the per-file caches so the next transform re-reads the changed
      // module instead of serving stale parsed values
      parsedFileInfoCache.delete(id);
      extractedClassesPerFile.delete(id);

      const cssModuleId = stylesheetImportPerFile.get(id);
      if (cssModuleId !== undefined) {
        stylesheetImportPerFile.delete(id);
        extractedCssPerFile.delete(cssModuleId);
      }
    },

    resolveId(id) {
      // Ensure CSS modules are treated as having side effects
      if (extractedCssPerFile.has(id)) {
        return id;
      }

      // Ensure JS modules with CSS extractions are included,
      // otherwise they may be tree-shaken away if
      // all their exports are evaluated away
      if (parsedFileInfoCache.has(id) && parsedFileInfoCache.get(id)!.declarations.length !== 0) {
        return id;
      }

      return null;
    },

    load(id) {
      // Return the CSS content for extracted CSS modules
      if (extractedCssPerFile.has(id)) {
        return extractedCssPerFile.get(id)!;
      }

      return null;
    },

    transform: {
      filter: {
        id: {
          include: makeIdFiltersToMatchWithQuery(include),
          exclude: makeIdFiltersToMatchWithQuery(exclude),
        },
      },
      async handler(code, id, meta) {
        // Check if the file references 'ecij'
        if (!code.includes('ecij')) {
          return null;
        }

        // Remove query parameters from the ID
        const cleanId = stripQuery(id);

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

        // Avoid outputing empty CSS modules
        if (cssContent !== '') {
          // Generate CSS module ID for this file
          // A hash of the CSS content is created to make HMR work
          // Use the original file path with .css extension
          // e.g., /src/components/Button.tsx -> /src/components/Button.tsx.hash.css
          const hash = hashText(cssContent);
          const cssModuleId = `${cleanId}.${hash}.css`;

          // Store the CSS extractions for this file. Keyed by the query-less id
          // so cross-module resolution and watchChange eviction can find them.
          extractedCssPerFile.set(cssModuleId, cssContent);
          stylesheetImportPerFile.set(cleanId, cssModuleId);

          const importStatements: string[] = [];

          // Include side-effect imports for modules from which class names were imported.
          // Otherwise, the original imports may be treated as being free of side-effects,
          // leading those imports to be omitted from the final bundle,
          // along with their extracted CSS.
          for (const dependency of stylesheetDependencies) {
            importStatements.push(`import ${JSON.stringify(dependency)};\n`);
          }

          // use JSON.stringify to properly escape the module ID,
          // including \ delimiters on Windows.
          importStatements.push(`import ${JSON.stringify(cssModuleId)};\n`);

          // Add side-effect/CSS module imports at the top of the file.
          magicString.prepend(importStatements.join(''));
        }

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
}
