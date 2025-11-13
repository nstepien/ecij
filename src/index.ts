import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { cwd } from 'node:process';
import { parseSync, Visitor, type TaggedTemplateExpression } from 'oxc-parser';
import type { Plugin, TransformPluginContext } from 'rolldown';

export interface Configuration {
  /**
   * Prefix for generated CSS class names.
   * Should not be empty, as generated hashes may start with a digit, resulting in invalid CSS class names.
   * @default 'css-'
   */
  classPrefix?: string;
}

interface Declaration {
  index: number;
  varName: string | undefined;
  node: TaggedTemplateExpression;
  hasInterpolations: boolean;
}

const JS_TS_FILE_REGEX = /\.[jtc]sx?$/;

// Get the project root directory
const PROJECT_ROOT = cwd();

function hashText(text: string): string {
  return createHash('md5').update(text).digest('hex').slice(0, 8);
}

/**
 * Removes the import statement for 'ecis'
 */
function removeImport(code: string): string {
  // Remove import { css } from 'ecis';
  return code.replace(/import\s+{\s*css\s*}\s+from\s+['"]ecis['"];?\s*/g, '');
}

/**
 * Adds import for CSS module at the top of the file
 */
function addCssImport(code: string, cssModuleId: string): string {
  // use JSON.stringify to properly escape the module ID, including \ delimiters on Windows
  return `import ${JSON.stringify(cssModuleId)};\n\n${code}`;
}

export function ecis({ classPrefix = 'css-' }: Configuration = {}): Plugin {
  // Map to store extracted CSS content per source file
  // Key: virtual module ID, Value: css content
  const extractedCssPerFile = new Map<string, string>();

  // Cache for resolved imported class names
  const importedClassNameCache = new Map<string, string>();

  /**
   * Generates a consistent, unique class name based on file path and variable name or index
   */
  function generateClassName(
    filePath: string,
    index: number,
    variableName: string | undefined,
  ): string {
    // Convert absolute path to project-relative path and normalize to Unix format
    // to ensure consistent hashes across different build environments (Windows/Unix)
    const relativePath = relative(PROJECT_ROOT, filePath).replaceAll('\\', '/');

    // Create a hash from the relative file path, index,
    // and identifier for consistency across builds.
    // The index is always used to avoid collisions with other variables
    // with the same name in the same file.
    const hash = hashText(`${relativePath}:${index}:${variableName}`);

    return `${classPrefix}${hash}`;
  }

  /**
   * Resolves an imported class name by reading and processing the source file
   */
  async function resolveImportedClassName(
    context: TransformPluginContext,
    importerPath: string,
    importSource: string,
    exportedName: string,
  ): Promise<string | undefined> {
    // Resolve the import path relative to the importer
    const resolvedId = await context.resolve(importSource, importerPath);

    if (resolvedId == null) return;

    const resolvedPath = resolvedId.id;

    // Check cache
    const cacheKey = `${resolvedPath}:${exportedName}`;

    if (importedClassNameCache.has(cacheKey)) {
      // TODO: turn this map into a map of maps (filePath => name => className)
      //       so we can avoid computing the same file multiple times.
      //       We should also cache the results of `extractCssFromCode`.
      return importedClassNameCache.get(cacheKey)!;
    }

    // Read the source file
    const sourceCode = await context.fs.readFile(resolvedPath, {
      encoding: 'utf8',
    });

    // Parse to find the exported variable
    const parseResult = parseSync(resolvedPath, sourceCode);

    const localNameToExportedNameMap = new Map<string, string>();

    for (const staticExport of parseResult.module.staticExports) {
      for (const entry of staticExport.entries) {
        // TODO: handle re-exports
        if (entry.importName.kind !== 'None') continue;

        // TODO: handle other export types (default, *)
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

    const declarations: Declaration[] = [];

    const taggedTemplateExpressionFromVariableDeclarator =
      new Set<TaggedTemplateExpression>();

    function handleTaggedTemplateExpression(
      varName: string | undefined,
      node: TaggedTemplateExpression,
    ) {
      if (node.tag.type === 'Identifier' && node.tag.name === 'css') {
        // Store info about this declaration
        declarations.push({
          index: declarations.length,
          varName,
          node,
          hasInterpolations: node.quasi.expressions.length > 0,
        });
      }
    }

    const visitor = new Visitor({
      VariableDeclarator(node) {
        if (node.init === null || node.id.type !== 'Identifier') return;

        const localName = node.id.name;

        if (node.init.type === 'TaggedTemplateExpression') {
          taggedTemplateExpressionFromVariableDeclarator.add(node.init);
          handleTaggedTemplateExpression(localName, node.init);
        } else if (
          node.init.type === 'Literal' &&
          typeof node.init.value === 'string'
        ) {
          const exportedName = localNameToExportedNameMap.get(localName);

          if (exportedName === undefined) return;

          const cacheKey = `${resolvedPath}:${exportedName}`;
          importedClassNameCache.set(cacheKey, node.init.value);
        }
      },
      TaggedTemplateExpression(node) {
        if (taggedTemplateExpressionFromVariableDeclarator.has(node)) {
          return;
        }

        // No variable name for inline expressions
        handleTaggedTemplateExpression(undefined, node);
      },
    });

    visitor.visit(parseResult.program);

    for (const declaration of declarations) {
      const localName = declaration.varName;

      if (localName === undefined) continue;

      const exportedName = localNameToExportedNameMap.get(localName);

      if (exportedName === undefined) continue;

      const cacheKey = `${resolvedPath}:${exportedName}`;
      const className = generateClassName(
        resolvedPath,
        declaration.index,
        localName,
      );
      importedClassNameCache.set(cacheKey, className);
    }

    return importedClassNameCache.get(cacheKey);
  }

  /**
   * Extracts CSS from template literals in the source code using AST parsing
   * Supports interpolations of class names (both local and imported)
   */
  async function extractCssFromCode(
    context: TransformPluginContext,
    code: string,
    filePath: string,
  ): Promise<{
    transformedCode: string;
    hasExtractions: boolean;
    cssContent: string;
    hasUnprocessedCssBlocks: boolean;
  }> {
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
    // Maps variable name to generated class name
    const localClassNames = new Map<string, string>();
    // Maps imported identifier to source file
    const imports = new Map<
      string,
      {
        source: string;
        imported: string;
      }
    >();

    // Helper to resolve a class name from an identifier
    function resolveClassName(
      identifierName: string,
    ): string | undefined | Promise<string | undefined> {
      // Check if it's a local class name
      if (localClassNames.has(identifierName)) {
        return localClassNames.get(identifierName)!;
      }

      // Check if it's an imported class name
      if (imports.has(identifierName)) {
        const { source, imported } = imports.get(identifierName)!;
        return resolveImportedClassName(context, filePath, source, imported);
      }

      return undefined;
    }

    // Parse the code into an AST
    const parseResult = parseSync(filePath, code);

    // First pass: collect import declarations
    for (const staticImport of parseResult.module.staticImports) {
      for (const entry of staticImport.entries) {
        // TODO: support default and namespace imports
        if (entry.importName.kind === 'Name') {
          imports.set(entry.localName.value, {
            source: staticImport.moduleRequest.value,
            imported: entry.importName.name!,
          });
        }
      }
    }

    const declarations: Declaration[] = [];

    const taggedTemplateExpressionFromVariableDeclarator =
      new Set<TaggedTemplateExpression>();

    function handleTaggedTemplateExpression(
      varName: string | undefined,
      node: TaggedTemplateExpression,
    ) {
      if (node.tag.type === 'Identifier' && node.tag.name === 'css') {
        // Store info about this declaration
        declarations.push({
          index: declarations.length,
          varName,
          node,
          hasInterpolations: node.quasi.expressions.length > 0,
        });
      }
    }

    // Do the tracking pass first to build localClassNames map
    const visitor = new Visitor({
      VariableDeclarator(node) {
        if (node.init === null || node.id.type !== 'Identifier') return;

        const localName = node.id.name;

        if (node.init.type === 'TaggedTemplateExpression') {
          taggedTemplateExpressionFromVariableDeclarator.add(node.init);
          handleTaggedTemplateExpression(localName, node.init);
        } else if (
          node.init.type === 'Literal' &&
          typeof node.init.value === 'string'
        ) {
          localClassNames.set(localName, node.init.value);
        }
      },
      TaggedTemplateExpression(node) {
        if (taggedTemplateExpressionFromVariableDeclarator.has(node)) {
          return;
        }

        // No variable name for inline expressions
        handleTaggedTemplateExpression(undefined, node);
      },
    });

    visitor.visit(parseResult.program);

    // Helper to add a processed CSS declaration
    function addProcessedDeclaration(
      declaration: Declaration,
      cssContent: string,
    ) {
      const className = generateClassName(
        filePath,
        declaration.index,
        declaration.varName,
      );

      // Only store in localClassNames if it has a variable name
      if (declaration.varName) {
        localClassNames.set(declaration.varName, className);
      }

      cssExtractions.push({
        className,
        cssContent: cssContent.trim(),
        sourcePosition: declaration.node.start,
      });

      replacements.push({
        start: declaration.node.start,
        end: declaration.node.end,
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
          // TODO: resolve static string values as well
          const resolvedClassName = await resolveClassName(identifierName);

          if (resolvedClassName === undefined) {
            // Cannot resolve - skip this entire css`` block
            allResolved = false;
            break;
          }

          cssContent += resolvedClassName;
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
        hasUnprocessedCssBlocks: false,
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

    // If we have any css`` blocks that couldn't be processed (skipped due to unresolved interpolations),
    // we shouldn't remove the css import
    const hasUnprocessedCssBlocks = declarations.length > replacements.length;

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
      hasUnprocessedCssBlocks,
    };
  }

  return {
    name: 'ecis',

    buildStart() {
      // Clear the cache when the server restarts
      extractedCssPerFile.clear();
      importedClassNameCache.clear();
    },

    resolveId(id) {
      // Intercept ecis imports to prevent Vite from trying to resolve them
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

    async transform(code, id) {
      // Remove query parameters from the ID
      const queryIndex = id.indexOf('?');
      const cleanId = queryIndex === -1 ? id : id.slice(0, queryIndex);

      // Only process JavaScript/TypeScript files
      // TODO: support `includes` option
      if (!JS_TS_FILE_REGEX.test(cleanId)) {
        return null;
      }

      // Check if the file references 'ecis'
      if (!code.includes('ecis')) {
        return null;
      }

      // Extract CSS from the code
      const {
        transformedCode,
        hasExtractions,
        cssContent,
        hasUnprocessedCssBlocks,
      } = await extractCssFromCode(this, code, cleanId);

      if (!hasExtractions) {
        return null;
      }

      // Generate CSS module ID for this file
      // A hash of the CSS content is created to make HMR work
      // Use the original file path with .css extension
      // e.g., /src/components/Button.tsx -> /src/components/Button.tsx.hash.css
      const hash = hashText(cssContent);
      const cssModuleId = `${cleanId}.${hash}.css`;

      // Store the CSS extractions for this file
      extractedCssPerFile.set(cssModuleId, cssContent);

      // Add CSS module import
      let finalCode = addCssImport(transformedCode, cssModuleId);

      // Only remove the css import if we processed all css`` blocks
      if (!hasUnprocessedCssBlocks) {
        finalCode = removeImport(finalCode);
      }

      // TODO return sourcemaps
      return finalCode;
    },
  };
}
