import * as vscode from 'vscode';

/**
 * File information with content
 */
export interface FileContent {
  uri: vscode.Uri;
  path: string;
  relativePath: string;
  content: string;
  languageId: string;
  lineCount: number;
}

/**
 * Symbol information from workspace
 */
export interface WorkspaceSymbol {
  name: string;
  kind: vscode.SymbolKind;
  kindName: string;
  containerName?: string;
  location: {
    uri: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  };
}

/**
 * File tree node
 */
export interface FileTreeNode {
  name: string;
  path: string;
  relativePath: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

/**
 * Search result from workspace
 */
export interface WorkspaceSearchResult {
  uri: vscode.Uri;
  path: string;
  relativePath: string;
  matches: Array<{
    line: number;
    lineContent: string;
    matchStart: number;
    matchEnd: number;
  }>;
}

/**
 * Chat reference with resolved content
 */
export interface ResolvedReference {
  id: string;
  type: 'file' | 'selection' | 'uri';
  uri?: vscode.Uri;
  range?: vscode.Range;
  content?: string;
  description?: string;
}

/**
 * WorkspaceContextManager - Provides comprehensive workspace access for the XORNG extension
 * 
 * This manager enables the extension to access the codebase similar to GitHub Copilot:
 * - Read files and file contents
 * - Search for files using glob patterns
 * - Search for text within files
 * - Get document symbols and workspace symbols
 * - Resolve chat references (files, selections)
 * - Build file trees for context
 */
export class WorkspaceContextManager implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private cachedFileTree: Map<string, FileTreeNode> = new Map();
  private recentlyAccessedFiles: vscode.Uri[] = [];
  private maxRecentFiles = 20;

  constructor() {
    this.setupFileWatcher();
  }

  /**
   * Setup file watcher for cache invalidation
   */
  private setupFileWatcher(): void {
    if (vscode.workspace.workspaceFolders?.[0]) {
      this.fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
      
      this.fileWatcher.onDidCreate(() => this.invalidateCache());
      this.fileWatcher.onDidDelete(() => this.invalidateCache());
      this.fileWatcher.onDidChange(() => this.invalidateCache());
      
      this.disposables.push(this.fileWatcher);
    }
  }

  private invalidateCache(): void {
    this.cachedFileTree.clear();
  }

  /**
   * Get the workspace root folder
   */
  getWorkspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  /**
   * Get all workspace folder URIs
   */
  getWorkspaceFolders(): vscode.Uri[] {
    return vscode.workspace.workspaceFolders?.map(f => f.uri) ?? [];
  }

  /**
   * Read a file's content
   */
  async readFile(uri: vscode.Uri, maxLines?: number): Promise<FileContent | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      let content = Buffer.from(bytes).toString('utf-8');
      
      // Optionally truncate to max lines
      if (maxLines && maxLines > 0) {
        const lines = content.split('\n');
        if (lines.length > maxLines) {
          content = lines.slice(0, maxLines).join('\n') + `\n... (${lines.length - maxLines} more lines)`;
        }
      }
      
      // Try to get language ID from open documents or file extension
      let languageId = 'plaintext';
      const openDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
      if (openDoc) {
        languageId = openDoc.languageId;
      } else {
        languageId = this.getLanguageIdFromPath(uri.fsPath);
      }

      const lineCount = content.split('\n').length;
      
      // Track recently accessed files
      this.trackRecentFile(uri);

      return {
        uri,
        path: uri.fsPath,
        relativePath: this.getRelativePath(uri),
        content,
        languageId,
        lineCount,
      };
    } catch (error) {
      console.error(`Failed to read file ${uri.fsPath}:`, error);
      return undefined;
    }
  }

  /**
   * Read a specific range from a file
   */
  async readFileRange(uri: vscode.Uri, range: vscode.Range): Promise<string | undefined> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      return doc.getText(range);
    } catch (error) {
      console.error(`Failed to read file range ${uri.fsPath}:`, error);
      return undefined;
    }
  }

  /**
   * Find files matching a glob pattern
   */
  async findFiles(
    pattern: string,
    exclude?: string,
    maxResults?: number,
    token?: vscode.CancellationToken
  ): Promise<vscode.Uri[]> {
    const excludePattern = exclude ?? '**/node_modules/**';
    return vscode.workspace.findFiles(pattern, excludePattern, maxResults, token);
  }

  /**
   * Search for text in workspace files
   */
  async searchInWorkspace(
    query: string,
    options?: {
      include?: string;
      exclude?: string;
      maxResults?: number;
      useRegex?: boolean;
      caseSensitive?: boolean;
    },
    token?: vscode.CancellationToken
  ): Promise<WorkspaceSearchResult[]> {
    const results: WorkspaceSearchResult[] = [];
    
    // Find files to search in
    const includePattern = options?.include ?? '**/*';
    const excludePattern = options?.exclude ?? '**/node_modules/**';
    const files = await this.findFiles(includePattern, excludePattern, options?.maxResults ?? 100, token);
    
    const searchRegex = options?.useRegex 
      ? new RegExp(query, options.caseSensitive ? 'g' : 'gi')
      : new RegExp(this.escapeRegex(query), options?.caseSensitive ? 'g' : 'gi');
    
    for (const fileUri of files) {
      if (token?.isCancellationRequested) break;
      
      try {
        const fileContent = await this.readFile(fileUri);
        if (!fileContent) continue;
        
        const lines = fileContent.content.split('\n');
        const matches: WorkspaceSearchResult['matches'] = [];
        
        lines.forEach((lineContent, lineIndex) => {
          let match;
          searchRegex.lastIndex = 0;
          while ((match = searchRegex.exec(lineContent)) !== null) {
            matches.push({
              line: lineIndex + 1,
              lineContent: lineContent.trim(),
              matchStart: match.index,
              matchEnd: match.index + match[0].length,
            });
          }
        });
        
        if (matches.length > 0) {
          results.push({
            uri: fileUri,
            path: fileUri.fsPath,
            relativePath: this.getRelativePath(fileUri),
            matches,
          });
        }
      } catch (error) {
        // Skip files that can't be read
        continue;
      }
    }
    
    return results;
  }

  /**
   * Get document symbols for a file
   */
  async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider',
        uri
      );
      return symbols ?? [];
    } catch (error) {
      console.error(`Failed to get document symbols for ${uri.fsPath}:`, error);
      return [];
    }
  }

  /**
   * Search for workspace symbols by query
   */
  async searchWorkspaceSymbols(query: string): Promise<WorkspaceSymbol[]> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        'vscode.executeWorkspaceSymbolProvider',
        query
      );
      
      return (symbols ?? []).map(s => ({
        name: s.name,
        kind: s.kind,
        kindName: vscode.SymbolKind[s.kind],
        containerName: s.containerName,
        location: {
          uri: s.location.uri.toString(),
          range: {
            start: { line: s.location.range.start.line, character: s.location.range.start.character },
            end: { line: s.location.range.end.line, character: s.location.range.end.character },
          },
        },
      }));
    } catch (error) {
      console.error(`Failed to search workspace symbols:`, error);
      return [];
    }
  }

  /**
   * Get file tree for workspace or specific folder
   */
  async getFileTree(
    rootUri?: vscode.Uri,
    depth: number = 3,
    exclude?: string
  ): Promise<FileTreeNode | undefined> {
    const root = rootUri ?? this.getWorkspaceRoot();
    if (!root) return undefined;

    const cacheKey = `${root.toString()}_${depth}_${exclude ?? ''}`;
    if (this.cachedFileTree.has(cacheKey)) {
      return this.cachedFileTree.get(cacheKey);
    }

    const tree = await this.buildFileTree(root, depth, exclude);
    if (tree) {
      this.cachedFileTree.set(cacheKey, tree);
    }
    return tree;
  }

  private async buildFileTree(
    uri: vscode.Uri,
    depth: number,
    exclude?: string
  ): Promise<FileTreeNode | undefined> {
    if (depth <= 0) return undefined;

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const name = uri.fsPath.split(/[/\\]/).pop() ?? '';
      const relativePath = this.getRelativePath(uri);

      if (stat.type === vscode.FileType.Directory) {
        const entries = await vscode.workspace.fs.readDirectory(uri);
        const children: FileTreeNode[] = [];

        for (const [entryName, entryType] of entries) {
          // Skip excluded patterns
          if (exclude && this.matchesPattern(entryName, exclude)) {
            continue;
          }
          // Skip common ignored directories
          if (['node_modules', '.git', 'dist', 'out', '.next', 'coverage'].includes(entryName)) {
            continue;
          }

          const childUri = vscode.Uri.joinPath(uri, entryName);
          
          if (entryType === vscode.FileType.Directory) {
            const childTree = await this.buildFileTree(childUri, depth - 1, exclude);
            if (childTree) {
              children.push(childTree);
            }
          } else if (entryType === vscode.FileType.File) {
            children.push({
              name: entryName,
              path: childUri.fsPath,
              relativePath: this.getRelativePath(childUri),
              type: 'file',
            });
          }
        }

        // Sort: directories first, then files, alphabetically
        children.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });

        return {
          name,
          path: uri.fsPath,
          relativePath,
          type: 'directory',
          children,
        };
      } else {
        return {
          name,
          path: uri.fsPath,
          relativePath,
          type: 'file',
        };
      }
    } catch (error) {
      console.error(`Failed to build file tree for ${uri.fsPath}:`, error);
      return undefined;
    }
  }

  /**
   * Resolve chat prompt references to their content
   */
  async resolveReferences(
    references: readonly vscode.ChatPromptReference[]
  ): Promise<ResolvedReference[]> {
    const resolved: ResolvedReference[] = [];

    for (const ref of references) {
      try {
        if (ref.value instanceof vscode.Uri) {
          // File reference
          const content = await this.readFile(ref.value);
          resolved.push({
            id: ref.id,
            type: 'file',
            uri: ref.value,
            content: content?.content,
            description: ref.modelDescription ?? `File: ${this.getRelativePath(ref.value)}`,
          });
        } else if (ref.value instanceof vscode.Location) {
          // Selection/range reference
          const content = await this.readFileRange(ref.value.uri, ref.value.range);
          resolved.push({
            id: ref.id,
            type: 'selection',
            uri: ref.value.uri,
            range: ref.value.range,
            content,
            description: ref.modelDescription ?? 
              `Selection in ${this.getRelativePath(ref.value.uri)} (lines ${ref.value.range.start.line + 1}-${ref.value.range.end.line + 1})`,
          });
        } else if (typeof ref.value === 'string') {
          // String reference (external URI or text)
          resolved.push({
            id: ref.id,
            type: 'uri',
            content: ref.value,
            description: ref.modelDescription ?? ref.value,
          });
        }
      } catch (error) {
        console.error(`Failed to resolve reference ${ref.id}:`, error);
      }
    }

    return resolved;
  }

  /**
   * Get the current editor's selection or entire file content
   */
  async getCurrentEditorContext(): Promise<{
    file?: FileContent;
    selection?: string;
    selectionRange?: vscode.Range;
  }> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return {};

    const fileContent = await this.readFile(editor.document.uri);
    
    let selection: string | undefined;
    let selectionRange: vscode.Range | undefined;
    
    if (!editor.selection.isEmpty) {
      selection = editor.document.getText(editor.selection);
      selectionRange = editor.selection;
    }

    return {
      file: fileContent,
      selection,
      selectionRange,
    };
  }

  /**
   * Get all open text documents
   */
  getOpenDocuments(): vscode.TextDocument[] {
    return [...vscode.workspace.textDocuments].filter(
      doc => doc.uri.scheme === 'file'
    );
  }

  /**
   * Get recently accessed files
   */
  getRecentFiles(): vscode.Uri[] {
    return [...this.recentlyAccessedFiles];
  }

  /**
   * Get visible editors' documents
   */
  getVisibleDocuments(): vscode.TextDocument[] {
    return vscode.window.visibleTextEditors
      .map(editor => editor.document)
      .filter(doc => doc.uri.scheme === 'file');
  }

  /**
   * Format file tree as string for context
   */
  formatFileTreeAsString(tree: FileTreeNode, indent: string = ''): string {
    let result = `${indent}${tree.type === 'directory' ? '📁 ' : '📄 '}${tree.name}\n`;
    
    if (tree.children) {
      for (const child of tree.children) {
        result += this.formatFileTreeAsString(child, indent + '  ');
      }
    }
    
    return result;
  }

  /**
   * Build context string from multiple resolved references
   */
  buildContextFromReferences(references: ResolvedReference[]): string {
    if (references.length === 0) return '';

    let context = '### Referenced Context:\n\n';
    
    for (const ref of references) {
      if (ref.content) {
        context += `**${ref.description}**\n`;
        context += '```\n' + ref.content + '\n```\n\n';
      }
    }
    
    return context;
  }

  // Helper methods

  private getRelativePath(uri: vscode.Uri): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) return uri.fsPath;
    
    const rootPath = workspaceRoot.fsPath;
    const filePath = uri.fsPath;
    
    if (filePath.startsWith(rootPath)) {
      return filePath.slice(rootPath.length + 1).replace(/\\/g, '/');
    }
    return filePath;
  }

  private getLanguageIdFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescriptreact',
      'js': 'javascript',
      'jsx': 'javascriptreact',
      'py': 'python',
      'java': 'java',
      'cs': 'csharp',
      'go': 'go',
      'rs': 'rust',
      'rb': 'ruby',
      'php': 'php',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'json': 'json',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'sh': 'shellscript',
      'bash': 'shellscript',
      'sql': 'sql',
      'xml': 'xml',
      'c': 'c',
      'cpp': 'cpp',
      'h': 'c',
      'hpp': 'cpp',
    };
    return langMap[ext] ?? 'plaintext';
  }

  private trackRecentFile(uri: vscode.Uri): void {
    // Remove if already exists
    const index = this.recentlyAccessedFiles.findIndex(
      f => f.toString() === uri.toString()
    );
    if (index !== -1) {
      this.recentlyAccessedFiles.splice(index, 1);
    }
    
    // Add to front
    this.recentlyAccessedFiles.unshift(uri);
    
    // Trim to max size
    if (this.recentlyAccessedFiles.length > this.maxRecentFiles) {
      this.recentlyAccessedFiles.pop();
    }
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private matchesPattern(name: string, pattern: string): boolean {
    // Simple pattern matching for exclude patterns
    const regex = new RegExp(
      pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.')
    );
    return regex.test(name);
  }

  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    this.cachedFileTree.clear();
    this.recentlyAccessedFiles = [];
  }
}
