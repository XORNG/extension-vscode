import * as vscode from 'vscode';
import { ChildProcess, fork } from 'child_process';
import * as path from 'path';
import {
  IPCMessage,
  IPCRequest,
  IPCResponse,
  LLMRequestMessage,
  LLMStreamRequestMessage,
  LLMStreamChunkMessage,
  LLMResponseMessage,
  SubAgentInfo,
  ProcessRequestMessage,
  ProcessResponseMessage,
  ProcessStreamChunkMessage,
  CoreReadyMessage,
  isIPCRequest,
  isLLMRequest,
  isLLMStreamRequest,
  createIPCRequest,
  createIPCResponse,
} from '../ipc/types.js';

/**
 * LocalOrchestrator - Manages XORNG Core as a local child process
 * 
 * Key responsibilities:
 * - Spawns Core via fork() with IPC channel
 * - Proxies LLM requests from Core to VS Code Language Model API
 * - Manages Core lifecycle (start, restart, graceful shutdown)
 * - Handles message routing between extension and Core
 */
export class LocalOrchestrator implements vscode.Disposable {
  private coreProcess: ChildProcess | null = null;
  private corePath: string;
  private isReady = false;
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private streamHandlers = new Map<string, (chunk: ProcessStreamChunkMessage) => void>();
  
  private readonly onCoreReadyEmitter = new vscode.EventEmitter<CoreReadyMessage>();
  private readonly onCoreErrorEmitter = new vscode.EventEmitter<Error>();
  private readonly onCoreExitEmitter = new vscode.EventEmitter<number | null>();
  
  public readonly onCoreReady = this.onCoreReadyEmitter.event;
  public readonly onCoreError = this.onCoreErrorEmitter.event;
  public readonly onCoreExit = this.onCoreExitEmitter.event;
  
  private outputChannel: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  
  constructor(corePath: string) {
    this.corePath = corePath;
    this.outputChannel = vscode.window.createOutputChannel('XORNG Core');
    this.disposables.push(this.outputChannel);
  }

  /**
   * Start the Core process
   */
  async start(): Promise<boolean> {
    if (this.coreProcess) {
      this.log('Core is already running');
      return true;
    }

    return new Promise((resolve) => {
      try {
        const coreEntryPoint = path.join(this.corePath, 'dist', 'ipc-handler.js');
        
        this.log(`Starting Core from: ${coreEntryPoint}`);
        
        this.coreProcess = fork(coreEntryPoint, [], {
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          cwd: this.corePath,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            XORNG_IPC_MODE: 'true',
          },
        });

        // Handle stdout
        this.coreProcess.stdout?.on('data', (data: Buffer) => {
          this.log(`[stdout] ${data.toString().trim()}`);
        });

        // Handle stderr
        this.coreProcess.stderr?.on('data', (data: Buffer) => {
          this.log(`[stderr] ${data.toString().trim()}`);
        });

        // Handle IPC messages
        this.coreProcess.on('message', (msg: unknown) => {
          this.handleMessage(msg);
        });

        // Handle process errors
        this.coreProcess.on('error', (error: Error) => {
          this.log(`Core error: ${error.message}`);
          this.onCoreErrorEmitter.fire(error);
          resolve(false);
        });

        // Handle process exit
        this.coreProcess.on('exit', (code: number | null) => {
          this.log(`Core exited with code: ${code}`);
          this.isReady = false;
          this.coreProcess = null;
          this.onCoreExitEmitter.fire(code);
          
          // Reject all pending requests
          for (const [id, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Core process exited'));
          }
          this.pendingRequests.clear();
        });

        // Wait for ready message or timeout
        const readyTimeout = setTimeout(() => {
          if (!this.isReady) {
            this.log('Core startup timeout');
            this.stop();
            resolve(false);
          }
        }, 30000);

        // Listen for ready event
        const readyHandler = this.onCoreReady(() => {
          clearTimeout(readyTimeout);
          readyHandler.dispose();
          resolve(true);
        });

      } catch (error) {
        this.log(`Failed to start Core: ${error}`);
        resolve(false);
      }
    });
  }

  /**
   * Stop the Core process gracefully
   */
  async stop(): Promise<void> {
    if (!this.coreProcess) {
      return;
    }

    const processToKill = this.coreProcess;

    return new Promise((resolve) => {
      const forceKillTimeout = setTimeout(() => {
        this.log('Force killing Core process');
        processToKill.kill('SIGKILL');
        resolve();
      }, 5000);

      processToKill.once('exit', () => {
        clearTimeout(forceKillTimeout);
        resolve();
      });

      // Send shutdown message via IPC request
      this.sendMessage(createIPCRequest('core:shutdown' as IPCRequest['type'], { reason: 'Extension deactivating' }));

      // Then send SIGTERM
      setTimeout(() => {
        processToKill.kill('SIGTERM');
      }, 1000);
    });
  }

  /**
   * Restart the Core process
   */
  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  /**
   * Check if Core is running and ready
   */
  isRunning(): boolean {
    return this.coreProcess !== null && this.isReady;
  }

  /**
   * Send a message to Core and wait for response
   */
  async sendRequest<T extends IPCResponse>(
    type: string,
    payload: unknown,
    timeoutMs = 30000
  ): Promise<T> {
    if (!this.isRunning()) {
      throw new Error('Core is not running');
    }

    const request = createIPCRequest(type as IPCRequest['type'], payload);
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(request.id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this.sendMessage(request);
    });
  }

  /**
   * Send a streaming request to Core
   */
  async sendStreamingRequest(
    type: string,
    payload: unknown,
    onChunk: (chunk: ProcessStreamChunkMessage) => void,
    timeoutMs = 60000
  ): Promise<ProcessResponseMessage> {
    if (!this.isRunning()) {
      throw new Error('Core is not running');
    }

    const request = createIPCRequest(type as IPCRequest['type'], {
      ...payload as object,
      stream: true,
    });
    
    // Register stream handler
    this.streamHandlers.set(request.id, onChunk);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        this.streamHandlers.delete(request.id);
        reject(new Error(`Streaming request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(request.id, {
        resolve: (response) => {
          this.streamHandlers.delete(request.id);
          resolve(response as ProcessResponseMessage);
        },
        reject: (error) => {
          this.streamHandlers.delete(request.id);
          reject(error);
        },
        timeout,
      });

      this.sendMessage(request);
    });
  }

  /**
   * Get list of available sub-agents
   */
  async getSubAgents(type?: string): Promise<SubAgentInfo[]> {
    const response = await this.sendRequest<IPCResponse>(
      'agents:list',
      { type }
    );
    
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to get agents');
    }
    
    return (response.payload as { agents: SubAgentInfo[] }).agents;
  }

  /**
   * Process a request through Core
   */
  async process(
    prompt: string,
    options: ProcessRequestMessage['payload']['options'] = {},
    context: ProcessRequestMessage['payload']['context'] = {}
  ): Promise<ProcessResponseMessage['payload']> {
    const response = await this.sendRequest<ProcessResponseMessage>(
      'process:request',
      { prompt, options, context }
    );
    
    if (!response.success) {
      throw new Error(response.error?.message || 'Processing failed');
    }
    
    return response.payload;
  }

  /**
   * Process a request with streaming
   */
  async processStream(
    prompt: string,
    onChunk: (content: string, done: boolean) => void,
    options: ProcessRequestMessage['payload']['options'] = {},
    context: ProcessRequestMessage['payload']['context'] = {}
  ): Promise<ProcessResponseMessage['payload']> {
    const response = await this.sendStreamingRequest(
      'process:request',
      { prompt, options: { ...options, stream: true }, context },
      (chunk) => {
        onChunk(chunk.payload.content, chunk.payload.done);
      }
    );
    
    if (!response.success) {
      throw new Error(response.error?.message || 'Processing failed');
    }
    
    return response.payload;
  }

  /**
   * Get token usage statistics
   */
  async getTokenUsage(): Promise<{
    totalPromptTokens: number;
    totalCompletionTokens: number;
    estimatedCost: number;
  }> {
    const response = await this.sendRequest<IPCResponse>('tokens:usage', {});
    
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to get token usage');
    }
    
    return response.payload as {
      totalPromptTokens: number;
      totalCompletionTokens: number;
      estimatedCost: number;
    };
  }

  /**
   * Handle incoming IPC messages
   */
  private handleMessage(msg: unknown): void {
    if (!isIPCRequest(msg)) {
      this.log(`Invalid message received: ${JSON.stringify(msg)}`);
      return;
    }

    const message = msg as IPCMessage;

    // Handle Core ready
    if (message.type === 'core:ready') {
      this.isReady = true;
      this.log('Core is ready');
      this.onCoreReadyEmitter.fire(message as CoreReadyMessage);
      return;
    }

    // Handle LLM requests from Core (proxy to VS Code Language Model API)
    if (isLLMRequest(msg)) {
      this.handleLLMRequest(msg as LLMRequestMessage);
      return;
    }

    if (isLLMStreamRequest(msg)) {
      this.handleLLMStreamRequest(msg as LLMStreamRequestMessage);
      return;
    }

    // Handle stream chunks
    if (message.type === 'process:chunk') {
      const chunk = message as ProcessStreamChunkMessage;
      const handler = this.streamHandlers.get(chunk.requestId);
      if (handler) {
        handler(chunk);
      }
      return;
    }

    // Handle responses to our requests
    if ('requestId' in message) {
      const response = message as IPCResponse;
      const pending = this.pendingRequests.get(response.requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(response.requestId);
        
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.error?.message || 'Request failed'));
        }
      }
    }
  }

  /**
   * Handle LLM request from Core - proxy to VS Code Language Model API
   */
  private async handleLLMRequest(request: LLMRequestMessage): Promise<void> {
    try {
      const { messages, options } = request.payload;
      
      // Get a model from VS Code
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: options?.model || 'gpt-4o',
      });

      if (models.length === 0) {
        this.sendMessage(createIPCResponse<LLMResponseMessage>(
          'llm:response',
          request.id,
          false,
          undefined,
          { code: 'NO_MODEL', message: 'No language model available' }
        ));
        return;
      }

      const model = models[0];
      
      // Convert messages to VS Code format
      const vscodeMessages = messages.map(m => {
        if (m.role === 'user') {
          return vscode.LanguageModelChatMessage.User(m.content);
        } else if (m.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant(m.content);
        } else {
          // System messages go as user messages with system prefix
          return vscode.LanguageModelChatMessage.User(`[System]: ${m.content}`);
        }
      });

      // Send request
      const response = await model.sendRequest(
        vscodeMessages,
        { 
          modelOptions: options?.maxTokens ? { max_tokens: options.maxTokens } : undefined 
        },
        new vscode.CancellationTokenSource().token
      );

      // Collect response
      let content = '';
      for await (const chunk of response.text) {
        content += chunk;
      }

      this.sendMessage(createIPCResponse<LLMResponseMessage>(
        'llm:response',
        request.id,
        true,
        { content }
      ));

    } catch (error) {
      this.sendMessage(createIPCResponse<LLMResponseMessage>(
        'llm:response',
        request.id,
        false,
        undefined,
        {
          code: 'LLM_ERROR',
          message: error instanceof Error ? error.message : 'LLM request failed',
        }
      ));
    }
  }

  /**
   * Handle streaming LLM request from Core
   */
  private async handleLLMStreamRequest(request: LLMStreamRequestMessage): Promise<void> {
    try {
      const { messages, options } = request.payload;
      
      const models = await vscode.lm.selectChatModels({
        vendor: 'copilot',
        family: options?.model || 'gpt-4o',
      });

      if (models.length === 0) {
        this.sendMessage(createIPCResponse<LLMResponseMessage>(
          'llm:response',
          request.id,
          false,
          undefined,
          { code: 'NO_MODEL', message: 'No language model available' }
        ));
        return;
      }

      const model = models[0];
      
      const vscodeMessages = messages.map(m => {
        if (m.role === 'user') {
          return vscode.LanguageModelChatMessage.User(m.content);
        } else if (m.role === 'assistant') {
          return vscode.LanguageModelChatMessage.Assistant(m.content);
        } else {
          return vscode.LanguageModelChatMessage.User(`[System]: ${m.content}`);
        }
      });

      const response = await model.sendRequest(
        vscodeMessages,
        { 
          modelOptions: options?.maxTokens ? { max_tokens: options.maxTokens } : undefined 
        },
        new vscode.CancellationTokenSource().token
      );

      // Stream chunks back to Core
      let fullContent = '';
      for await (const chunk of response.text) {
        fullContent += chunk;
        this.sendMessage({
          type: 'llm:chunk',
          id: `chunk_${Date.now()}`,
          timestamp: Date.now(),
          requestId: request.id,
          payload: { content: chunk, done: false },
        } as LLMStreamChunkMessage);
      }

      // Send final response
      this.sendMessage(createIPCResponse<LLMResponseMessage>(
        'llm:response',
        request.id,
        true,
        { content: fullContent }
      ));

    } catch (error) {
      this.sendMessage(createIPCResponse<LLMResponseMessage>(
        'llm:response',
        request.id,
        false,
        undefined,
        {
          code: 'LLM_ERROR',
          message: error instanceof Error ? error.message : 'LLM request failed',
        }
      ));
    }
  }

  /**
   * Send message to Core process
   */
  private sendMessage(message: IPCMessage): void {
    if (this.coreProcess && this.coreProcess.connected) {
      this.coreProcess.send(message);
    }
  }

  /**
   * Log to output channel
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  /**
   * Show output channel
   */
  showOutput(): void {
    this.outputChannel.show();
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.stop();
    this.onCoreReadyEmitter.dispose();
    this.onCoreErrorEmitter.dispose();
    this.onCoreExitEmitter.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
