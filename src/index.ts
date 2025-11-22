import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';
import { parseSync, Visitor, type TaggedTemplateExpression } from 'oxc-parser';
import { makeIdFiltersToMatchWithQuery } from '@rolldown/pluginutils';
import type { Plugin, TransformPluginContext } from 'rolldown';

export interface Configuration {
  /**
   * Include patterns for files to process.
   * Can be a string, RegExp, or array of strings/RegExp.
   * @default /\.[cm]?[jt]sx?$/
   */
  include?: string | RegExp | ReadonlyArray<string | RegExp>;

  /**
   * Exclude patterns for files to skip.
   * Can be a string, RegExp, or array of strings/RegExp.
   * @default [/\/node_modules\//, /\.d\.ts$/]
   */
  exclude?: string | RegExp | ReadonlyArray<string | RegExp>;

  /**
   * Prefix for generated CSS class names.
   * Should not be empty, as generated hashes may start with a digit, resulting in invalid CSS class names.
   * @default 'css-'
   */
  classPrefix?: string;
}

interface Declaration {
  className: string;
  node: TaggedTemplateExpression;
  hasInterpolations: boolean;
}

interface ParsedFileInfo {
  readonly declarations: readonly Declaration[];
  readonly localIdentifiers: ReadonlyMap<string, string>;
  readonly importedIdentifiers: ReadonlyMap<
    string,
    { source: string; imported: string }
  >;
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

export function ecij({
  include = JS_TS_FILE_REGEX,
  exclude = [NODE_MODULES_REGEX, D_TS_FILE_REGEX],
  classPrefix = 'css-',
}: Configuration = {}): Plugin {
  const parsedFileInfoCache = new Map<string, ParsedFileInfo>();

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
    const sourceText =
      code ?? (await context.fs.readFile(filePath, { encoding: 'utf8' }));

    const parseResult = parseSync(filePath, sourceText);
    const declarations: Declaration[] = [];
    const localIdentifiers = new Map<string, string>();
    const importedIdentifiers = new Map<
      string,
      { source: string; imported: string }
    >();
    const exportNameToValueMap = new Map<string, string>();
    const localNameToExportedNameMap = new Map<string, string>();
    const taggedTemplateExpressionFromVariableDeclarator =
      new Set<TaggedTemplateExpression>();
    let hasCSSTagImport = false;

    const parsedInfo: ParsedFileInfo = {
      declarations,
      localIdentifiers,
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
        if (
          entry.exportName.kind === 'Name' &&
          entry.localName.kind === 'Name'
        ) {
          const localName = entry.localName.name!;
          const exportedName = entry.exportName.name!;
          localNameToExportedNameMap.set(localName, exportedName);
        }
      }
    }

    function recordIdentifierWithValue(localName: string, value: string) {
      localIdentifiers.set(localName, value);

      if (localNameToExportedNameMap.has(localName)) {
        const exportedName = localNameToExportedNameMap.get(localName)!;
        exportNameToValueMap.set(exportedName, value);
      }
    }

    function handleTaggedTemplateExpression(
      localName: string | undefined,
      node: TaggedTemplateExpression,
    ) {
      if (
        !(
          hasCSSTagImport &&
          node.tag.type === 'Identifier' &&
          node.tag.name === 'css'
        )
      ) {
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
        hasInterpolations: node.quasi.expressions.length > 0,
      });

      // Record generated class names for css declarations
      if (localName !== undefined) {
        recordIdentifierWithValue(localName, className);
      }
    }

    // Visit AST to collect declarations and literal values
    const visitor = new Visitor({
      VariableDeclarator(node) {
        if (node.init === null || node.id.type !== 'Identifier') return;

        const localName = node.id.name;

        if (node.init.type === 'TaggedTemplateExpression') {
          taggedTemplateExpressionFromVariableDeclarator.add(node.init);
          handleTaggedTemplateExpression(localName, node.init);
        } else if (
          node.init.type === 'Literal' &&
          (typeof node.init.value === 'string' ||
            typeof node.init.value === 'number')
        ) {
          const value = String(node.init.value);
          recordIdentifierWithValue(localName, value);
        }
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
  ): Promise<{
    transformedCode: string;
    hasExtractions: boolean;
    cssContent: string;
  }> {
    const { declarations, localIdentifiers, importedIdentifiers } =
      await parseFile(context, filePath, code);

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

    // Helper to resolve a value from an identifier
    async function resolveValue(
      identifierName: string,
    ): Promise<string | undefined> {
      // Check if it's a local identifier
      if (localIdentifiers.has(identifierName)) {
        return localIdentifiers.get(identifierName)!;
      }

      // Check if it's an imported identifier
      if (importedIdentifiers.has(identifierName)) {
        const { source, imported } = importedIdentifiers.get(identifierName)!;

        // Resolve the import path relative to the importer
        const resolvedId = await context.resolve(source, filePath);

        if (resolvedId != null) {
          const { exportNameToValueMap } = await parseFile(
            context,
            resolvedId.id,
          );

          return exportNameToValueMap.get(imported);
        }
      }

      return;
    }

    // Helper to add a processed CSS declaration
    function addProcessedDeclaration(
      declaration: Declaration,
      cssContent: string,
    ) {
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

      const cssContent = declaration.node.quasi.quasis[0].value.raw;
      addProcessedDeclaration(declaration, cssContent);
    }

    // Pass 2: With interpolations using resolved local references
    for (const declaration of declarations) {
      if (!declaration.hasInterpolations) continue;

      const { quasis, expressions } = declaration.node.quasi;

      let cssContent = '';
      let allResolved = true;

      for (let i = 0; i < quasis.length; i++) {
        cssContent += quasis[i].value.raw;

        if (i < expressions.length) {
          const expression = expressions[i];

          if (expression.type !== 'Identifier') {
            // Complex expression - skip this entire css`` block
            allResolved = false;
            break;
          }

          const identifierName = expression.name;
          const resolvedValue = await resolveValue(identifierName);

          if (resolvedValue === undefined) {
            // Cannot resolve - skip this entire css`` block
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
        transformedCode: code,
        hasExtractions: false,
        cssContent: '',
      };
    }

    // Sort replacements by start position in descending order
    // This ensures we apply replacements from end to start, preserving positions
    replacements.sort((a, b) => b.start - a.start);

    // Apply replacements from highest position to lowest to maintain correct indices
    let transformedCode = code;

    for (const { start, end, className } of replacements) {
      transformedCode = `${transformedCode.slice(0, start)}'${className}'${transformedCode.slice(end)}`;
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
      transformedCode,
      hasExtractions: true,
      cssContent,
    };
  }

  return {
    name: 'ecij',

    buildEnd() {
      // Clear caches between builds
      parsedFileInfoCache.clear();
      extractedCssPerFile.clear();
    },

    resolveId(id) {
      // Intercept ecij imports to prevent Vite from trying to resolve them
      // They will be removed during transformation
      if (extractedCssPerFile.has(id)) {
        return { id };
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
      async handler(code, id) {
        // Check if the file references 'ecij'
        if (!code.includes('ecij')) {
          return null;
        }

        // Remove query parameters from the ID
        const queryIndex = id.indexOf('?');
        const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);

        // Extract CSS from the code
        const { transformedCode, hasExtractions, cssContent } =
          await extractCssFromCode(this, code, cleanId);

        if (!hasExtractions) {
          return null;
        }

        // Avoid outputing empty CSS modules
        if (cssContent === '') {
          return transformedCode;
        }

        // Generate CSS module ID for this file
        // A hash of the CSS content is created to make HMR work
        // Use the original file path with .css extension
        // e.g., /src/components/Button.tsx -> /src/components/Button.tsx.hash.css
        const hash = hashText(cssContent);
        const cssModuleId = `${cleanId}.${hash}.css`;

        // Store the CSS extractions for this file
        extractedCssPerFile.set(cssModuleId, cssContent);

        // use JSON.stringify to properly escape the module ID,
        // including \ delimiters on Windows.
        const importStatement = `import ${JSON.stringify(cssModuleId)};`;

        // Add CSS module import at the top of the file.
        return `${importStatement}\n${transformedCode}`;
      },
    },
  };
}
