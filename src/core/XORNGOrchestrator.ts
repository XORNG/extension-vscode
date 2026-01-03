import * as vscode from 'vscode';
import type {
  Message,
  XORNGContext,
  XORNGRequest,
  XORNGResponse,
  SubAgentDefinition,
  RoutingDecision,
} from '../types/index.js';
import { ProviderManager } from './ProviderManager.js';
import { CopilotProvider } from '../providers/CopilotProvider.js';
import { LocalOrchestrator, OrchestratorConfig } from './LocalOrchestrator.js';
import type { SubAgentInfo } from '../ipc/types.js';
import type { WorkspaceContextManager, ResolvedReference } from '../workspace/WorkspaceContextManager.js';

/**
 * System prompts for XORNG orchestration
 */
const SYSTEM_PROMPTS = {
  default: `You are XORNG, an intelligent AI orchestration system with full access to the user's codebase. You help developers with code analysis, reviews, and best practices.

You have access to tools that let you:
- Read files from the workspace
- Search for files using patterns
- Search for text within files
- Get code symbols (functions, classes, variables)
- Navigate the file tree structure
- Access currently open files and selections

You have access to specialized sub-agents for different tasks:
- Validators: code-review, security analysis
- Knowledge: documentation, best practices
- Tasks: refactoring, testing

When the user references files or code, use the workspace tools to gather relevant context before responding. Provide helpful, accurate, and contextual responses based on the actual codebase. When reviewing code, be specific about issues and suggest improvements.`,

  review: `You are XORNG's Code Review Agent with full codebase access. Analyze the provided code for:
1. Code quality and readability
2. Potential bugs and edge cases
3. Performance considerations
4. Best practices adherence
5. Naming conventions and documentation

Use the workspace tools to understand the broader context of the code being reviewed. Look at related files, imports, and usages to provide comprehensive feedback. Be specific about issues found and provide actionable suggestions for improvement.`,

  security: `You are XORNG's Security Analysis Agent with full codebase access. Analyze the provided code for:
1. Security vulnerabilities (injection, XSS, CSRF, etc.)
2. Authentication and authorization issues
3. Data validation and sanitization
4. Sensitive data exposure
5. Security best practices

Use the workspace tools to trace data flow across files and identify security issues that span multiple components. Rate the severity of issues found (Critical, High, Medium, Low) and provide remediation steps.`,

  explain: `You are XORNG's Documentation Agent with full codebase access. Your task is to explain code and concepts clearly:
1. Break down complex logic into understandable parts
2. Explain the purpose and functionality
3. Describe how components interact
4. Provide context about design decisions
5. Suggest documentation improvements

Use the workspace tools to explore related code, find usage examples, and understand the broader architecture. Use clear language and examples where helpful.`,

  refactor: `You are XORNG's Refactoring Agent with full codebase access. Analyze and improve code structure:
1. Identify code smells and anti-patterns
2. Suggest cleaner implementations
3. Improve modularity and reusability
4. Enhance type safety and error handling
5. Apply SOLID principles

Use the workspace tools to understand dependencies and ensure refactoring suggestions don't break other parts of the codebase. Provide before/after examples and explain the benefits of each change.`,

  config: `You are XORNG's Configuration Assistant. Help users configure XORNG:
- Explain available settings and their effects
- Guide through provider selection (Copilot, Native, etc.)
- Configure sub-agents and memory settings
- Troubleshoot configuration issues`,
};

/**
 * Sub-agent definitions
 * 
 * Capabilities must match the Distributor's mapIntentToCapabilities in Core:
 * - code-review intent expects: ['code-analysis', 'linting']
 * - security intent expects: ['security-scan', 'vulnerability-detection']
 * - standards intent expects: ['style-check', 'best-practices']
 * - documentation intent expects: ['documentation-generation', 'explanation']
 * - refactor intent expects: ['code-transformation', 'optimization']
 */
const SUB_AGENTS: SubAgentDefinition[] = [
  {
    id: 'code-review',
    name: 'Code Review',
    type: 'validator',
    description: 'Reviews code for quality, bugs, and best practices',
    capabilities: ['code-analysis', 'linting', 'quality-check'],
    prompts: { system: SYSTEM_PROMPTS.review },
  },
  {
    id: 'security',
    name: 'Security Analysis',
    type: 'validator',
    description: 'Analyzes code for security vulnerabilities',
    capabilities: ['security-scan', 'vulnerability-detection'],
    prompts: { system: SYSTEM_PROMPTS.security },
  },
  {
    id: 'documentation',
    name: 'Documentation',
    type: 'knowledge',
    description: 'Explains code and provides documentation',
    capabilities: ['documentation-generation', 'explanation'],
    prompts: { system: SYSTEM_PROMPTS.explain },
  },
  {
    id: 'refactoring',
    name: 'Refactoring',
    type: 'task',
    description: 'Suggests code improvements and refactoring',
    capabilities: ['code-transformation', 'optimization'],
    prompts: { system: SYSTEM_PROMPTS.refactor },
  },
];

/**
 * XORNGOrchestrator - Main orchestration engine for the VS Code extension
 * 
 * Handles:
 * - Chat request processing
 * - Sub-agent routing and coordination (local Core via IPC)
 * - Context management and workspace access
 * - Response aggregation
 * - Chat reference resolution (files, selections)
 */
export class XORNGOrchestrator implements vscode.Disposable {
  private providerManager: ProviderManager;
  private workspaceContext: WorkspaceContextManager | null = null;
  private requestCounter = 0;
  private conversationHistory: Message[] = [];
  private localOrchestrator: LocalOrchestrator | null = null;
  private coreEnabled = false;
  private coreAgents: SubAgentInfo[] = [];
  private disposables: vscode.Disposable[] = [];
  private corePath: string = '';
  private redisUrl: string = 'redis://localhost:6379';
  private logLevel: string = 'info';

  constructor(
    providerManager: ProviderManager,
    corePath?: string,
    workspaceContext?: WorkspaceContextManager
  ) {
    this.providerManager = providerManager;
    this.workspaceContext = workspaceContext ?? null;
    if (corePath) {
      this.corePath = corePath;
    }
  }

  /**
   * Set the workspace context manager
   */
  setWorkspaceContext(workspaceContext: WorkspaceContextManager): void {
    this.workspaceContext = workspaceContext;
  }

  /**
   * Get the workspace context manager
   */
  getWorkspaceContext(): WorkspaceContextManager | null {
    return this.workspaceContext;
  }

  /**
   * Initialize with Core path (called after setup)
   */
  setCorePath(corePath: string): void {
    this.corePath = corePath;
  }

  /**
   * Set Redis URL for Core configuration
   */
  setRedisUrl(redisUrl: string): void {
    this.redisUrl = redisUrl;
  }

  /**
   * Set log level for Core
   */
  setLogLevel(logLevel: string): void {
    this.logLevel = logLevel;
  }

  /**
   * Start the local Core process
   */
  async startCore(): Promise<boolean> {
    if (!this.corePath) {
      console.warn('Core path not set, cannot start Core');
      return false;
    }

    if (this.localOrchestrator?.isRunning()) {
      return true;
    }

    const config: OrchestratorConfig = {
      corePath: this.corePath,
      redisUrl: this.redisUrl,
      logLevel: this.logLevel,
    };

    this.localOrchestrator = new LocalOrchestrator(config);
    
    // Listen for Core events
    this.disposables.push(
      this.localOrchestrator.onCoreReady(async () => {
        this.coreEnabled = true;
        
        // Register all sub-agents with Core
        await this.registerSubAgentsWithCore();
        
        // Fetch available agents to verify registration
        try {
          this.coreAgents = await this.localOrchestrator!.getSubAgents();
          console.log(`Registered ${this.coreAgents.length} agents with Core`);
        } catch (e) {
          console.warn('Failed to fetch agents:', e);
        }
      })
    );

    this.disposables.push(
      this.localOrchestrator.onCoreError((error) => {
        vscode.window.showWarningMessage(`XORNG Core error: ${error.message}`);
      })
    );

    this.disposables.push(
      this.localOrchestrator.onCoreExit((code) => {
        this.coreEnabled = false;
        if (code !== 0 && code !== null) {
          vscode.window.showWarningMessage(`XORNG Core exited unexpectedly (code ${code})`);
        }
      })
    );

    const started = await this.localOrchestrator.start();
    if (started) {
      vscode.window.showInformationMessage('XORNG Core started successfully');
    } else {
      vscode.window.showErrorMessage('Failed to start XORNG Core');
    }

    return started;
  }

  /**
   * Stop the local Core process
   */
  async stopCore(): Promise<void> {
    if (this.localOrchestrator) {
      await this.localOrchestrator.stop();
      this.coreEnabled = false;
    }
  }

  /**
   * Register all sub-agents with Core
   */
  private async registerSubAgentsWithCore(): Promise<void> {
    if (!this.localOrchestrator) {
      console.warn('Cannot register agents: LocalOrchestrator not available');
      return;
    }

    for (const agent of SUB_AGENTS) {
      try {
        await this.localOrchestrator.registerAgent({
          id: agent.id,
          name: agent.name,
          type: agent.type,
          description: agent.description,
          capabilities: agent.capabilities,
          // Virtual agents are processed by the orchestrator using VS Code LLM API
          // They don't spawn external processes
          connectionType: 'virtual',
          // Pass the system prompt as metadata for virtual agent execution
          metadata: {
            systemPrompt: agent.prompts.system,
          },
        });
        console.log(`Registered agent: ${agent.id}`);
      } catch (e) {
        console.error(`Failed to register agent ${agent.id}:`, e);
      }
    }
  }

  /**
   * Check if Core is running
   */
  isCoreRunning(): boolean {
    return this.localOrchestrator?.isRunning() ?? false;
  }

  /**
   * Get the LocalOrchestrator instance
   */
  getLocalOrchestrator(): LocalOrchestrator | null {
    return this.localOrchestrator;
  }

  /**
   * Check if Core is available for processing
   */
  isCoreAvailable(): boolean {
    return this.coreEnabled && (this.localOrchestrator?.isRunning() ?? false);
  }

  /**
   * Handle a chat request from the chat participant
   */
  async handleChatRequest(
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken
  ): Promise<vscode.ChatResult> {
    const requestId = `req_${++this.requestCounter}_${Date.now()}`;
    const startTime = Date.now();

    try {
      // Show progress
      stream.progress('XORNG is processing your request...');

      // Check if Core is available and should be used
      if (this.isCoreAvailable()) {
        return this.handleChatRequestViaCore(requestId, request, chatContext, stream, token, startTime);
      }

      // Fall back to local processing
      return this.handleChatRequestLocally(requestId, request, chatContext, stream, token, startTime);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      stream.markdown(`\n\n⚠️ **Error:** ${errorMessage}`);
      
      return {
        metadata: {
          command: request.command,
          requestId,
          error: errorMessage,
        },
      };
    }
  }

  /**
   * Handle chat request via XORNG Core (IPC)
   */
  private async handleChatRequestViaCore(
    requestId: string,
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    startTime: number
  ): Promise<vscode.ChatResult> {
    stream.progress('Processing via XORNG Core...');

    const context = this.buildContext();
    
    try {
      // Stream response from Core via IPC
      const response = await this.localOrchestrator!.processStream(
        request.prompt,
        (chunk: string, done: boolean) => {
          if (token.isCancellationRequested) {
            return;
          }
          if (chunk) {
            stream.markdown(chunk);
          }
        },
        { includeMemory: true },
        {
          projectPath: context.workspaceFolder?.fsPath,
          currentFile: context.currentFile?.fsPath,
          selectedCode: context.selectedCode,
          metadata: {
            command: request.command,
            vscodeRequestId: requestId,
            model: {
              vendor: request.model.vendor,
              family: request.model.family,
              id: request.model.id
            }
          },
        }
      );

      // Check if any agents were actually invoked
      if (response.metadata?.agentsInvoked === 0) {
        console.log('No agents invoked by Core, falling back to local processing');
        return this.handleChatRequestLocally(requestId, request, chatContext, stream, token, startTime);
      }

      const executionTime = Date.now() - startTime;

      // Add reference
      stream.reference(vscode.Uri.parse('https://github.com/XORNG'));

      return {
        metadata: {
          command: request.command,
          requestId,
          executionTimeMs: executionTime,
          provider: 'xorng-core',
          coreMetadata: response.metadata,
        },
      };
    } catch (error) {
      // Fall back to local processing on Core error
      console.warn('Core processing failed, falling back to local:', error);
      stream.markdown('\n*Falling back to local processing...*\n\n');
      return this.handleChatRequestLocally(requestId, request, chatContext, stream, token, startTime);
    }
  }

  /**
   * Handle chat request locally (without Core)
   */
  private async handleChatRequestLocally(
    requestId: string,
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    token: vscode.CancellationToken,
    startTime: number
  ): Promise<vscode.ChatResult> {
    // Build XORNG request
    const xorngRequest = this.buildRequest(requestId, request);
    
    // Route to appropriate handler based on command
    const systemPrompt = this.getSystemPrompt(request.command);
    
    // Build messages for the LLM with resolved references
    // Use the enhanced method that resolves chat references (files, selections)
    const messages = await this.buildMessagesWithReferences(systemPrompt, request, chatContext, stream);

    // Get provider and process request
    const provider = this.providerManager.getCurrentProvider();
    const providerType = this.providerManager.getCurrentProviderType();

    let usedModelInfo: { usedModel?: string; usedFamily?: string } = {};

    // Use the model from the request if using Copilot
    if (providerType === 'copilot') {
      const copilotProvider = this.providerManager.getCopilotProvider();
      
      // Determine which model family to use
      // If task specific models are enabled, getModelForTask returns the task model
      // If disabled, it returns the configured modelFamily
      // We prioritize configuration over the UI dropdown to ensure 'modelFamily' setting works
      const targetModelFamily = this.providerManager.getModelForTask(request.command);
      const isTaskSpecific = this.providerManager.isTaskSpecificModelsEnabled();
      
      if (isTaskSpecific) {
        console.log(`XORNG Orchestrator: Task-specific models ENABLED`);
        console.log(`XORNG Orchestrator: Command: '${request.command || '(none)'}' -> Target family: '${targetModelFamily}'`);
        stream.progress(`Using configured model: ${targetModelFamily}`);
      } else {
        console.log(`XORNG Orchestrator: Task-specific models DISABLED - using configured model family: ${targetModelFamily}`);
        // If the user has configured a specific model family, we use it instead of the dropdown selection
        // This ensures the 'modelFamily' setting is respected
      }

      console.log(`XORNG Orchestrator: User's dropdown selection was: '${request.model.family}' (ignored in favor of configuration)`);
      
      usedModelInfo = await copilotProvider.sendStreamingRequestWithFamily(
        messages,
        stream,
        targetModelFamily,
        {},
        token
      );
      
      // Show which model was actually used at the end if it differs from request or is task specific
      if (isTaskSpecific || (usedModelInfo.usedFamily && request.model.family && !usedModelInfo.usedFamily.includes(request.model.family))) {
        stream.markdown(`\n\n---\n*Model used: ${usedModelInfo.usedFamily}*`);
      }
      
      console.log(`XORNG Orchestrator: Actually used model: ${usedModelInfo.usedFamily} (${usedModelInfo.usedModel})`);
    } else {
      await provider.sendStreamingRequest(messages, stream, {}, token);
    }

    // Add reference to indicate XORNG processed this
    stream.reference(vscode.Uri.parse('https://github.com/XORNG'));

    const executionTime = Date.now() - startTime;

    return {
      metadata: {
        command: request.command,
        requestId,
        executionTimeMs: executionTime,
        provider: providerType,
        modelUsed: usedModelInfo.usedModel,
        modelFamily: usedModelInfo.usedFamily,
        taskSpecificModels: this.providerManager.isTaskSpecificModelsEnabled(),
      },
    };
  }

  /**
   * Build XORNG request from chat request
   */
  private buildRequest(requestId: string, request: vscode.ChatRequest): XORNGRequest {
    const context = this.buildContext();

    return {
      id: requestId,
      prompt: request.prompt,
      command: request.command,
      context,
      timestamp: new Date(),
    };
  }

  /**
   * Build context from VS Code state
   */
  private buildContext(): XORNGContext {
    const context: XORNGContext = {};

    // Get workspace folder
    if (vscode.workspace.workspaceFolders?.[0]) {
      context.workspaceFolder = vscode.workspace.workspaceFolders[0].uri;
    }

    // Get current file
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      context.currentFile = activeEditor.document.uri;
      
      // Get selected code if any
      const selection = activeEditor.selection;
      if (!selection.isEmpty) {
        context.selectedCode = activeEditor.document.getText(selection);
      }
    }

    return context;
  }

  /**
   * Get system prompt based on command
   */
  private getSystemPrompt(command?: string): string {
    switch (command) {
      case 'review':
        return SYSTEM_PROMPTS.review;
      case 'security':
        return SYSTEM_PROMPTS.security;
      case 'explain':
        return SYSTEM_PROMPTS.explain;
      case 'refactor':
        return SYSTEM_PROMPTS.refactor;
      case 'config':
        return SYSTEM_PROMPTS.config;
      default:
        return SYSTEM_PROMPTS.default;
    }
  }

  /**
   * Build messages array for the LLM, including resolved chat references
   */
  private async buildMessagesWithReferences(
    systemPrompt: string,
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream
  ): Promise<Message[]> {
    const messages: Message[] = [];

    // Add system prompt with information about available tools
    let enhancedSystemPrompt = systemPrompt;
    
    // If workspace context is available, add tool information
    if (this.workspaceContext) {
      enhancedSystemPrompt += `\n\nYou have access to the following workspace tools to explore the codebase:
- xorng_readFile: Read the contents of a file
- xorng_findFiles: Find files matching a glob pattern
- xorng_searchWorkspace: Search for text in workspace files
- xorng_getSymbols: Get code symbols from a file or search workspace symbols
- xorng_getFileTree: Get the workspace file structure
- xorng_getFileContent: Read specific line ranges from a file
- xorng_getOpenFiles: Get currently open and visible files
- xorng_getCurrentEditor: Get current editor context and selection

Use these tools when you need more context about the codebase to provide accurate answers.`;
    }

    messages.push({
      role: 'system',
      content: enhancedSystemPrompt,
    });

    // Add conversation history from chat context
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({
          role: 'user',
          content: turn.prompt,
        });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        // Extract text from response parts
        let responseText = '';
        for (const part of turn.response) {
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            responseText += part.value.value;
          }
        }
        if (responseText) {
          messages.push({
            role: 'assistant',
            content: responseText,
          });
        }
      }
    }

    // Build user message with context
    let userMessage = '';

    // Resolve and include chat references (files, selections attached by user)
    if (request.references && request.references.length > 0 && this.workspaceContext) {
      const resolvedRefs = await this.workspaceContext.resolveReferences(request.references);
      
      if (resolvedRefs.length > 0) {
        userMessage += '### Referenced Context (attached by user):\n\n';
        
        for (const ref of resolvedRefs) {
          if (ref.content) {
            // Add reference to the response stream for UI
            if (ref.uri) {
              stream.reference(ref.uri);
            }
            
            userMessage += `**${ref.description}**\n`;
            userMessage += '```\n' + ref.content + '\n```\n\n';
          }
        }
      }
    }

    // Add selected code context if available (from active editor)
    const context = this.buildContext();
    if (context.selectedCode && !userMessage.includes(context.selectedCode)) {
      userMessage += `### Currently Selected Code:\n\`\`\`\n${context.selectedCode}\n\`\`\`\n\n`;
    }

    // Add current file info
    if (context.currentFile) {
      userMessage += `### Active File: ${context.currentFile.fsPath}\n\n`;
    }

    // Add workspace info
    if (context.workspaceFolder) {
      userMessage += `### Workspace: ${context.workspaceFolder.fsPath}\n\n`;
    }

    // Add the actual user prompt
    userMessage += `### User Request:\n${request.prompt}`;

    messages.push({
      role: 'user',
      content: userMessage,
    });

    return messages;
  }

  /**
   * Build messages array for the LLM (legacy sync method)
   */
  private buildMessages(
    systemPrompt: string,
    request: vscode.ChatRequest,
    chatContext: vscode.ChatContext
  ): Message[] {
    const messages: Message[] = [];

    // Add system prompt
    messages.push({
      role: 'system',
      content: systemPrompt,
    });

    // Add conversation history from chat context
    for (const turn of chatContext.history) {
      if (turn instanceof vscode.ChatRequestTurn) {
        messages.push({
          role: 'user',
          content: turn.prompt,
        });
      } else if (turn instanceof vscode.ChatResponseTurn) {
        // Extract text from response parts
        let responseText = '';
        for (const part of turn.response) {
          if (part instanceof vscode.ChatResponseMarkdownPart) {
            responseText += part.value.value;
          }
        }
        if (responseText) {
          messages.push({
            role: 'assistant',
            content: responseText,
          });
        }
      }
    }

    // Add current request with context
    let userMessage = request.prompt;

    // Add selected code context if available
    const context = this.buildContext();
    if (context.selectedCode) {
      userMessage = `The user has selected the following code:\n\`\`\`\n${context.selectedCode}\n\`\`\`\n\nUser request: ${request.prompt}`;
    }

    // Add current file context
    if (context.currentFile) {
      userMessage += `\n\nCurrent file: ${context.currentFile.fsPath}`;
    }

    messages.push({
      role: 'user',
      content: userMessage,
    });

    return messages;
  }

  /**
   * Route request to appropriate sub-agents
   */
  private routeRequest(request: XORNGRequest): RoutingDecision {
    const promptLower = request.prompt.toLowerCase();
    const primaryAgents: string[] = [];
    const secondaryAgents: string[] = [];

    // Check for explicit command
    if (request.command) {
      switch (request.command) {
        case 'review':
          primaryAgents.push('code-review');
          secondaryAgents.push('documentation');
          break;
        case 'security':
          primaryAgents.push('security');
          break;
        case 'explain':
          primaryAgents.push('documentation');
          break;
        case 'refactor':
          primaryAgents.push('refactoring');
          secondaryAgents.push('code-review');
          break;
      }
    }

    // Auto-detect intent if no command specified
    if (primaryAgents.length === 0) {
      if (promptLower.includes('review') || promptLower.includes('check')) {
        primaryAgents.push('code-review');
      }
      if (promptLower.includes('security') || promptLower.includes('vulnerab')) {
        primaryAgents.push('security');
      }
      if (promptLower.includes('explain') || promptLower.includes('what')) {
        primaryAgents.push('documentation');
      }
      if (promptLower.includes('refactor') || promptLower.includes('improve')) {
        primaryAgents.push('refactoring');
      }
    }

    // Default to documentation if nothing detected
    if (primaryAgents.length === 0) {
      primaryAgents.push('documentation');
    }

    return {
      primaryAgents,
      secondaryAgents,
      parallel: primaryAgents.length > 1,
      priority: 1,
    };
  }

  /**
   * Get available sub-agents (from Core or local fallback)
   */
  getSubAgents(): SubAgentDefinition[] {
    // If Core is connected, use Core agents
    if (this.isCoreAvailable() && this.coreAgents.length > 0) {
      return this.coreAgents.map(agent => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        description: agent.description,
        capabilities: agent.capabilities,
        prompts: { system: SYSTEM_PROMPTS.default },
        status: agent.status,
      }));
    }
    return SUB_AGENTS;
  }

  /**
   * Get Core sub-agents (raw format)
   */
  getCoreAgents(): SubAgentInfo[] {
    return this.coreAgents;
  }

  /**
   * Refresh agents from Core
   */
  async refreshAgents(): Promise<void> {
    if (this.localOrchestrator?.isRunning()) {
      try {
        this.coreAgents = await this.localOrchestrator.getSubAgents();
      } catch (e) {
        console.warn('Failed to refresh agents:', e);
      }
    }
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Dispose resources
   */
  async dispose(): Promise<void> {
    this.conversationHistory = [];
    await this.stopCore();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
