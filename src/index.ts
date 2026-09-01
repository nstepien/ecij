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
  scope: Scope;
}

interface ParsedFileInfo {
  readonly declarations: readonly Declaration[];
  readonly importedIdentifiers: ReadonlyMap<string, { source: string; imported: string }>;
  readonly exportNameToValueMap: ReadonlyMap<string, string>;
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

export function ecij(configuration?: Configuration | null): Plugin {
  const include = configuration?.include ?? JS_TS_FILE_REGEX;
  const exclude = configuration?.exclude ?? [NODE_MODULES_REGEX, D_TS_FILE_REGEX];
  const classPrefix = configuration?.classPrefix ?? 'css-';

  const parsedFileInfoCache = new Map<string, ParsedFileInfo>();

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

    // Helper to resolve a value from an identifier, walking up the scope chain
    async function resolveValue(identifierName: string, scope: Scope): Promise<string | undefined> {
      if (scope.identifiers.has(identifierName)) {
        // May return undefined for declarations with unknown values (e.g. function params),
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
          // populate the cache for the imported file
          await context.load(resolvedId);

          const { id } = resolvedId;

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
      stylesheetImportPerFile.clear();
      extractedCssPerFile.clear();
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

        // Avoid outputing empty CSS modules
        if (cssContent !== '') {
          // Generate CSS module ID for this file
          // A hash of the CSS content is created to make HMR work
          // Use the original file path with .css extension
          // e.g., /src/components/Button.tsx -> /src/components/Button.tsx.hash.css
          const hash = hashText(cssContent);
          const cssModuleId = `${cleanId}.${hash}.css`;

          // Store the CSS extractions for this file
          extractedCssPerFile.set(cssModuleId, cssContent);
          stylesheetImportPerFile.set(id, cssModuleId);

          const importStatements: string[] = [];

          // Include side-effect imports for modules from which class names were imported.
          // Otherwise, the original imports may be treated as being free of side-effects,
          // leading those imports to be omitted from the final bundle,
          // along with their extracted CSS.
          for (const id of stylesheetDependencies) {
            importStatements.push(`import ${JSON.stringify(id)};\n`);
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
