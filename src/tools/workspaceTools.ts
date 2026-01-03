import * as vscode from 'vscode';
import { WorkspaceContextManager, FileContent, WorkspaceSearchResult, WorkspaceSymbol, FileTreeNode } from '../workspace/WorkspaceContextManager.js';

/**
 * XORNG Language Model Tools
 * 
 * These tools enable the language model to access the codebase, similar to GitHub Copilot:
 * - Read files and file contents
 * - Search for files using glob patterns
 * - Search for text within files
 * - Get document and workspace symbols
 * - Get file tree structure
 * - Get open/visible documents
 */

// Tool parameter interfaces
interface IReadFileParameters {
  path: string;
  maxLines?: number;
}

interface IFindFilesParameters {
  pattern: string;
  exclude?: string;
  maxResults?: number;
}

interface ISearchWorkspaceParameters {
  query: string;
  include?: string;
  exclude?: string;
  maxResults?: number;
  useRegex?: boolean;
  caseSensitive?: boolean;
}

interface IGetSymbolsParameters {
  path?: string;
  query?: string;
}

interface IGetFileTreeParameters {
  depth?: number;
  exclude?: string;
}

interface IGetFileContentParameters {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Tool to read file contents from the workspace
 */
export class ReadFileTool implements vscode.LanguageModelTool<IReadFileParameters> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IReadFileParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;
    
    const workspaceRoot = this.contextManager.getWorkspaceRoot();
    if (!workspaceRoot) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No workspace folder is open.')
      ]);
    }

    // Resolve path (absolute or relative to workspace)
    let fileUri: vscode.Uri;
    if (params.path.startsWith('/') || params.path.match(/^[a-zA-Z]:/)) {
      fileUri = vscode.Uri.file(params.path);
    } else {
      fileUri = vscode.Uri.joinPath(workspaceRoot, params.path);
    }

    const fileContent = await this.contextManager.readFile(fileUri, params.maxLines);
    
    if (!fileContent) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Could not read file: ${params.path}`)
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `File: ${fileContent.relativePath}\n` +
        `Language: ${fileContent.languageId}\n` +
        `Lines: ${fileContent.lineCount}\n\n` +
        '```' + fileContent.languageId + '\n' +
        fileContent.content + '\n```'
      )
    ]);
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IReadFileParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Reading file: ${options.input.path}`,
    };
  }
}

/**
 * Tool to find files matching a glob pattern
 */
export class FindFilesTool implements vscode.LanguageModelTool<IFindFilesParameters> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IFindFilesParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;
    
    const files = await this.contextManager.findFiles(
      params.pattern,
      params.exclude ?? '**/node_modules/**',
      params.maxResults ?? 50,
      token
    );

    if (files.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No files found matching pattern: ${params.pattern}`)
      ]);
    }

    const workspaceRoot = this.contextManager.getWorkspaceRoot();
    const relativePaths = files.map(f => {
      if (workspaceRoot && f.fsPath.startsWith(workspaceRoot.fsPath)) {
        return f.fsPath.slice(workspaceRoot.fsPath.length + 1).replace(/\\/g, '/');
      }
      return f.fsPath;
    });

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(
        `Found ${files.length} files matching "${params.pattern}":\n\n` +
        relativePaths.map(p => `- ${p}`).join('\n')
      )
    ]);
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IFindFilesParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Searching for files matching: ${options.input.pattern}`,
    };
  }
}

/**
 * Tool to search for text within workspace files
 */
export class SearchWorkspaceTool implements vscode.LanguageModelTool<ISearchWorkspaceParameters> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<ISearchWorkspaceParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;
    
    const results = await this.contextManager.searchInWorkspace(
      params.query,
      {
        include: params.include,
        exclude: params.exclude ?? '**/node_modules/**',
        maxResults: params.maxResults ?? 20,
        useRegex: params.useRegex ?? false,
        caseSensitive: params.caseSensitive ?? false,
      },
      token
    );

    if (results.length === 0) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`No results found for: "${params.query}"`)
      ]);
    }

    let resultText = `Found matches in ${results.length} files for "${params.query}":\n\n`;
    
    for (const result of results) {
      resultText += `### ${result.relativePath}\n`;
      for (const match of result.matches.slice(0, 5)) { // Limit matches per file
        resultText += `  Line ${match.line}: ${match.lineContent}\n`;
      }
      if (result.matches.length > 5) {
        resultText += `  ... and ${result.matches.length - 5} more matches\n`;
      }
      resultText += '\n';
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(resultText)
    ]);
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<ISearchWorkspaceParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: `Searching workspace for: "${options.input.query}"`,
    };
  }
}

/**
 * Tool to get symbols from a file or workspace
 */
export class GetSymbolsTool implements vscode.LanguageModelTool<IGetSymbolsParameters> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IGetSymbolsParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;
    
    if (params.path) {
      // Get document symbols for specific file
      const workspaceRoot = this.contextManager.getWorkspaceRoot();
      let fileUri: vscode.Uri;
      
      if (params.path.startsWith('/') || params.path.match(/^[a-zA-Z]:/)) {
        fileUri = vscode.Uri.file(params.path);
      } else if (workspaceRoot) {
        fileUri = vscode.Uri.joinPath(workspaceRoot, params.path);
      } else {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart('No workspace folder is open.')
        ]);
      }

      const symbols = await this.contextManager.getDocumentSymbols(fileUri);
      
      if (symbols.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`No symbols found in: ${params.path}`)
        ]);
      }

      const symbolsText = this.formatDocumentSymbols(symbols);
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Symbols in ${params.path}:\n\n${symbolsText}`)
      ]);
    } else if (params.query) {
      // Search workspace symbols
      const symbols = await this.contextManager.searchWorkspaceSymbols(params.query);
      
      if (symbols.length === 0) {
        return new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(`No symbols found matching: "${params.query}"`)
        ]);
      }

      const symbolsText = symbols
        .slice(0, 20) // Limit results
        .map(s => `- ${s.kindName} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''}`)
        .join('\n');

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `Found ${symbols.length} symbols matching "${params.query}":\n\n${symbolsText}`
        )
      ]);
    }

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart('Please provide either a file path or a search query.')
    ]);
  }

  private formatDocumentSymbols(symbols: vscode.DocumentSymbol[], indent: string = ''): string {
    let result = '';
    for (const symbol of symbols) {
      const kindName = vscode.SymbolKind[symbol.kind];
      result += `${indent}- ${kindName} ${symbol.name}`;
      if (symbol.detail) {
        result += ` : ${symbol.detail}`;
      }
      result += ` (line ${symbol.range.start.line + 1})\n`;
      
      if (symbol.children && symbol.children.length > 0) {
        result += this.formatDocumentSymbols(symbol.children, indent + '  ');
      }
    }
    return result;
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IGetSymbolsParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    if (options.input.path) {
      return { invocationMessage: `Getting symbols from: ${options.input.path}` };
    }
    return { invocationMessage: `Searching for symbols: "${options.input.query}"` };
  }
}

/**
 * Tool to get workspace file tree structure
 */
export class GetFileTreeTool implements vscode.LanguageModelTool<IGetFileTreeParameters> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IGetFileTreeParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;
    
    const tree = await this.contextManager.getFileTree(
      undefined,
      params.depth ?? 3,
      params.exclude
    );

    if (!tree) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No workspace folder is open.')
      ]);
    }

    const treeText = this.contextManager.formatFileTreeAsString(tree);
    
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`Workspace structure:\n\n${treeText}`)
    ]);
  }

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<IGetFileTreeParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: 'Getting workspace file structure',
    };
  }
}

/**
 * Tool to get specific lines from a file
 */
export class GetFileContentTool implements vscode.LanguageModelTool<IGetFileContentParameters> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<IGetFileContentParameters>,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const params = options.input;
    
    const workspaceRoot = this.contextManager.getWorkspaceRoot();
    if (!workspaceRoot) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No workspace folder is open.')
      ]);
    }

    let fileUri: vscode.Uri;
    if (params.path.startsWith('/') || params.path.match(/^[a-zA-Z]:/)) {
      fileUri = vscode.Uri.file(params.path);
    } else {
      fileUri = vscode.Uri.joinPath(workspaceRoot, params.path);
    }

    try {
      const doc = await vscode.workspace.openTextDocument(fileUri);
      const startLine = Math.max(0, (params.startLine ?? 1) - 1);
      const endLine = Math.min(doc.lineCount, params.endLine ?? doc.lineCount);
      
      const range = new vscode.Range(startLine, 0, endLine, 0);
      const content = doc.getText(range);

      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(
          `File: ${params.path} (lines ${startLine + 1}-${endLine})\n\n` +
          '```' + doc.languageId + '\n' +
          content + '\n```'
        )
      ]);
    } catch (error) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`Could not read file: ${params.path}`)
      ]);
    }
  }

  async prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<IGetFileContentParameters>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    const lineRange = options.input.startLine && options.input.endLine 
      ? ` (lines ${options.input.startLine}-${options.input.endLine})`
      : '';
    return {
      invocationMessage: `Reading ${options.input.path}${lineRange}`,
    };
  }
}

/**
 * Tool to get currently open/visible files
 */
export class GetOpenFilesTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const openDocs = this.contextManager.getOpenDocuments();
    const visibleDocs = this.contextManager.getVisibleDocuments();
    const recentFiles = this.contextManager.getRecentFiles();

    const workspaceRoot = this.contextManager.getWorkspaceRoot();
    
    const formatPath = (uri: vscode.Uri): string => {
      if (workspaceRoot && uri.fsPath.startsWith(workspaceRoot.fsPath)) {
        return uri.fsPath.slice(workspaceRoot.fsPath.length + 1).replace(/\\/g, '/');
      }
      return uri.fsPath;
    };

    let result = '### Currently Visible Files:\n';
    result += visibleDocs.map(d => `- ${formatPath(d.uri)}`).join('\n') || '(none)';
    
    result += '\n\n### Open Files:\n';
    result += openDocs.map(d => `- ${formatPath(d.uri)}`).join('\n') || '(none)';
    
    result += '\n\n### Recently Accessed:\n';
    result += recentFiles.slice(0, 10).map(f => `- ${formatPath(f)}`).join('\n') || '(none)';

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result)
    ]);
  }

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: 'Getting open and visible files',
    };
  }
}

/**
 * Tool to get the current editor context (selection, cursor position, etc.)
 */
export class GetCurrentEditorTool implements vscode.LanguageModelTool<Record<string, never>> {
  constructor(private contextManager: WorkspaceContextManager) {}

  async invoke(
    _options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelToolResult> {
    const context = await this.contextManager.getCurrentEditorContext();
    
    if (!context.file) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart('No active editor.')
      ]);
    }

    let result = `### Current File: ${context.file.relativePath}\n`;
    result += `Language: ${context.file.languageId}\n`;
    result += `Lines: ${context.file.lineCount}\n\n`;

    if (context.selection && context.selectionRange) {
      result += `### Selection (lines ${context.selectionRange.start.line + 1}-${context.selectionRange.end.line + 1}):\n`;
      result += '```' + context.file.languageId + '\n';
      result += context.selection + '\n```\n\n';
    }

    // Include some surrounding context (first 50 lines or so)
    const previewLines = context.file.content.split('\n').slice(0, 50);
    result += '### File Preview (first 50 lines):\n';
    result += '```' + context.file.languageId + '\n';
    result += previewLines.join('\n') + '\n```';

    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(result)
    ]);
  }

  async prepareInvocation(
    _options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
    _token: vscode.CancellationToken
  ): Promise<vscode.PreparedToolInvocation> {
    return {
      invocationMessage: 'Getting current editor context',
    };
  }
}

/**
 * Register all XORNG workspace tools
 */
export function registerWorkspaceTools(
  context: vscode.ExtensionContext,
  contextManager: WorkspaceContextManager
): void {
  // Register Read File Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_readFile', new ReadFileTool(contextManager))
  );

  // Register Find Files Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_findFiles', new FindFilesTool(contextManager))
  );

  // Register Search Workspace Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_searchWorkspace', new SearchWorkspaceTool(contextManager))
  );

  // Register Get Symbols Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_getSymbols', new GetSymbolsTool(contextManager))
  );

  // Register Get File Tree Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_getFileTree', new GetFileTreeTool(contextManager))
  );

  // Register Get File Content Tool (for specific line ranges)
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_getFileContent', new GetFileContentTool(contextManager))
  );

  // Register Get Open Files Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_getOpenFiles', new GetOpenFilesTool(contextManager))
  );

  // Register Get Current Editor Tool
  context.subscriptions.push(
    vscode.lm.registerTool('xorng_getCurrentEditor', new GetCurrentEditorTool(contextManager))
  );

  console.log('XORNG workspace tools registered');
}
