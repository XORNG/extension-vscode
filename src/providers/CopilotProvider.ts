import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider.js';
import type {
  Message,
  ProviderCapabilities,
  ProviderRequestOptions,
  ProviderResponse,
} from '../types/index.js';

/**
 * CopilotProvider - GitHub Copilot Language Model Provider
 * 
 * This provider leverages GitHub Copilot's language models through the VS Code
 * Language Model API (vscode.lm). It allows XORNG to use the user's Copilot
 * subscription for AI capabilities.
 * 
 * Key features:
 * - Uses the user's existing Copilot subscription
 * - Supports multiple model families (gpt-4.1, gpt-5, claude-sonnet-4.5, etc.)
 * - Dynamic model detection via vscode.lm API
 * - Streaming responses for real-time feedback
 * - Respects VS Code's chat model selection
 */
export class CopilotProvider extends BaseProvider {
  private preferredModelFamily: string;
  private cachedModel: vscode.LanguageModelChat | undefined;
  private availableModels: Map<string, vscode.LanguageModelChat> = new Map();
  private modelChangeDisposable: vscode.Disposable | undefined;
  private _onModelsChanged = new vscode.EventEmitter<string[]>();
  readonly onModelsChanged = this._onModelsChanged.event;

  constructor(modelFamily: string = 'gpt-4.1') {
    super('copilot', 'GitHub Copilot');
    this.preferredModelFamily = modelFamily;
    
    // Listen for model changes from VS Code
    this.modelChangeDisposable = vscode.lm.onDidChangeChatModels(() => {
      this.refreshAvailableModels();
    });
  }

  /**
   * Check if Copilot is available
   */
  async isAvailable(): Promise<boolean> {
    this.checkDisposed();
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Refresh the list of available models from VS Code
   * This is called automatically when models change, or can be called manually
   */
  async refreshAvailableModels(): Promise<Map<string, vscode.LanguageModelChat>> {
    this.checkDisposed();
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      this.availableModels.clear();
      
      for (const model of models) {
        // Use family as key since that's what we use for selection
        if (!this.availableModels.has(model.family)) {
          this.availableModels.set(model.family, model);
        }
      }
      
      // Clear cached model if it's no longer available
      if (this.cachedModel && !this.availableModels.has(this.cachedModel.family)) {
        this.cachedModel = undefined;
      }
      
      // Fire event to notify listeners
      this._onModelsChanged.fire(Array.from(this.availableModels.keys()));
      
      console.log(`XORNG: Detected ${this.availableModels.size} Copilot models:`, 
        Array.from(this.availableModels.keys()).join(', '));
      
      return this.availableModels;
    } catch (error) {
      console.error('XORNG: Failed to refresh available models:', error);
      return this.availableModels;
    }
  }

  /**
   * Get detailed information about all available models
   */
  async getAvailableModelsDetailed(): Promise<Array<{
    id: string;
    family: string;
    name: string;
    vendor: string;
    version: string;
    maxInputTokens: number;
  }>> {
    await this.refreshAvailableModels();
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    
    return models.map(model => ({
      id: model.id,
      family: model.family,
      name: model.name,
      vendor: model.vendor,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
    }));
  }

  /**
   * Get Copilot capabilities
   */
  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      vision: false, // Depends on model
      contextWindow: 128000, // gpt-4o default
    };
  }

  /**
   * Get or select a language model
   */
  private async getModel(
    preferredFamily?: string,
    requestModel?: vscode.LanguageModelChat
  ): Promise<vscode.LanguageModelChat> {
    // If a model is provided in the request (from chat participant), use it
    if (requestModel) {
      return requestModel;
    }

    // Try to use cached model
    if (this.cachedModel) {
      return this.cachedModel;
    }

    const family = preferredFamily || this.preferredModelFamily;
    
    // Select model by family
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: family,
    });

    if (models.length === 0) {
      // Fallback to any Copilot model
      const fallbackModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (fallbackModels.length === 0) {
        throw new Error('No Copilot models available. Please ensure GitHub Copilot is installed and activated.');
      }
      this.cachedModel = fallbackModels[0];
      return this.cachedModel;
    }

    this.cachedModel = models[0];
    return this.cachedModel;
  }

  /**
   * Send a non-streaming request
   */
  async sendRequest(
    messages: Message[],
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<ProviderResponse> {
    this.checkDisposed();

    const model = await this.getModel(options?.model);
    const lmMessages = this.toLanguageModelMessages(messages);

    const requestOptions: vscode.LanguageModelChatRequestOptions = {};
    if (options?.tools) {
      requestOptions.tools = options.tools;
    }

    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    try {
      const response = await model.sendRequest(lmMessages, requestOptions, cancellationToken);
      
      // Collect the full response
      let content = '';
      for await (const fragment of response.text) {
        content += fragment;
      }

      return {
        content,
        model: model.id,
      };
    } catch (error: unknown) {
      if (error instanceof vscode.LanguageModelError) {
        const lmError = error as vscode.LanguageModelError;
        throw new Error(`Copilot error (${lmError.code}): ${lmError.message}`);
      }
      throw error;
    }
  }

  /**
   * Send a streaming request
   */
  async sendStreamingRequest(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<void> {
    this.checkDisposed();

    const model = await this.getModel(options?.model);
    const lmMessages = this.toLanguageModelMessages(messages);

    const requestOptions: vscode.LanguageModelChatRequestOptions = {};
    if (options?.tools) {
      requestOptions.tools = options.tools;
    }

    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    try {
      const response = await model.sendRequest(lmMessages, requestOptions, cancellationToken);

      // Stream the response
      for await (const fragment of response.text) {
        stream.markdown(fragment);
      }
    } catch (error: unknown) {
      if (error instanceof vscode.LanguageModelError) {
        const lmError = error as vscode.LanguageModelError;
        if (lmError.cause instanceof Error && lmError.cause.message.includes('off_topic')) {
          stream.markdown(vscode.l10n.t("I'm sorry, I cannot help with that request."));
          return;
        }
        throw new Error(`Copilot error (${lmError.code}): ${lmError.message}`);
      }
      throw error;
    }
  }

  /**
   * Send a streaming request with a model from the chat request
   * This is the preferred method when handling chat participant requests
   */
  async sendStreamingRequestWithModel(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    requestModel: vscode.LanguageModelChat,
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<void> {
    this.checkDisposed();

    const lmMessages = this.toLanguageModelMessages(messages);

    const requestOptions: vscode.LanguageModelChatRequestOptions = {};
    if (options?.tools) {
      requestOptions.tools = options.tools;
    }

    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    try {
      const response = await requestModel.sendRequest(lmMessages, requestOptions, cancellationToken);

      for await (const fragment of response.text) {
        stream.markdown(fragment);
      }
    } catch (error: unknown) {
      if (error instanceof vscode.LanguageModelError) {
        const lmError = error as vscode.LanguageModelError;
        if (lmError.cause instanceof Error && lmError.cause.message.includes('off_topic')) {
          stream.markdown(vscode.l10n.t("I'm sorry, I cannot help with that request."));
          return;
        }
        throw new Error(`Copilot error (${lmError.code}): ${lmError.message}`);
      }
      throw error;
    }
  }

  /**
   * Update the preferred model family
   */
  setModelFamily(family: string): void {
    this.preferredModelFamily = family;
    this.cachedModel = undefined; // Clear cache to pick up new family
  }

  /**
   * Get available model families (simple string array)
   */
  async getAvailableModels(): Promise<string[]> {
    await this.refreshAvailableModels();
    return Array.from(this.availableModels.keys());
  }

  /**
   * Get cached available models (synchronous, returns last known state)
   */
  getCachedAvailableModels(): string[] {
    return Array.from(this.availableModels.keys());
  }

  dispose(): void {
    this.cachedModel = undefined;
    this.availableModels.clear();
    this.modelChangeDisposable?.dispose();
    this._onModelsChanged.dispose();
    super.dispose();
  }
}
