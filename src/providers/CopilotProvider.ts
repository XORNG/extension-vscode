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
   * @param preferredFamily The preferred model family (e.g., 'gpt-4o', 'claude-3.5-sonnet')
   * @param requestModel Optional model from chat request (used when respecting UI selection)
   * @param skipCache If true, always fetch fresh model (useful for task-specific routing)
   */
  private async getModel(
    preferredFamily?: string,
    requestModel?: vscode.LanguageModelChat,
    skipCache: boolean = false
  ): Promise<vscode.LanguageModelChat> {
    // If a model is provided in the request (from chat participant), use it
    if (requestModel) {
      return requestModel;
    }

    const family = preferredFamily || this.preferredModelFamily;

    // Try to use cached model if it matches the requested family (unless skipCache)
    if (!skipCache && this.cachedModel && this.cachedModel.family === family) {
      return this.cachedModel;
    }
    
    // Select model by family
    console.log(`XORNG CopilotProvider: Selecting model with family '${family}'`);
    const models = await vscode.lm.selectChatModels({
      vendor: 'copilot',
      family: family,
    });

    if (models.length > 0) {
      console.log(`XORNG CopilotProvider: Found ${models.length} model(s) for family '${family}': ${models.map(m => m.id).join(', ')}`);
      // Don't cache when skipCache is true (for task-specific routing)
      if (!skipCache) {
        this.cachedModel = models[0];
      }
      return models[0];
    }

    // Family not found - try partial match by searching all models
    console.log(`XORNG CopilotProvider: No exact match for family '${family}', searching all models...`);
    const allModels = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    
    if (allModels.length === 0) {
      throw new Error('No Copilot models available. Please ensure GitHub Copilot is installed and activated.');
    }

    // Try to find a model that contains the family name (partial match)
    const familyLower = family.toLowerCase();
    const partialMatch = allModels.find(m => 
      m.family.toLowerCase().includes(familyLower) || 
      familyLower.includes(m.family.toLowerCase()) ||
      m.id.toLowerCase().includes(familyLower)
    );

    if (partialMatch) {
      console.log(`XORNG CopilotProvider: Found partial match: ${partialMatch.family} (${partialMatch.id})`);
      if (!skipCache) {
        this.cachedModel = partialMatch;
      }
      return partialMatch;
    }

    // Log available models for debugging
    console.log(`XORNG CopilotProvider: Available model families: ${allModels.map(m => m.family).join(', ')}`);
    console.log(`XORNG CopilotProvider: Falling back to first available model: ${allModels[0].family}`);
    
    // Fallback to first available model
    if (!skipCache) {
      this.cachedModel = allModels[0];
    }
    return allModels[0];
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
   * Send a streaming request using a specific model family
   * This method selects a model programmatically based on the family, 
   * ignoring the user's chat dropdown selection.
   * Use this for task-specific model routing.
   */
  async sendStreamingRequestWithFamily(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    modelFamily: string,
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<{ usedModel: string; usedFamily: string }> {
    this.checkDisposed();

    // Select model by family - skip cache to ensure we get the right model for this task
    const model = await this.getModel(modelFamily, undefined, true);
    
    console.log(`XORNG CopilotProvider.sendStreamingRequestWithFamily: Requested '${modelFamily}', using '${model.family}' (${model.id})`);
    
    const lmMessages = this.toLanguageModelMessages(messages);

    const requestOptions: vscode.LanguageModelChatRequestOptions = {};
    if (options?.tools) {
      requestOptions.tools = options.tools;
    }

    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    try {
      const response = await model.sendRequest(lmMessages, requestOptions, cancellationToken);

      for await (const fragment of response.text) {
        stream.markdown(fragment);
      }

      return {
        usedModel: model.id,
        usedFamily: model.family,
      };
    } catch (error: unknown) {
      if (error instanceof vscode.LanguageModelError) {
        const lmError = error as vscode.LanguageModelError;
        if (lmError.cause instanceof Error && lmError.cause.message.includes('off_topic')) {
          stream.markdown(vscode.l10n.t("I'm sorry, I cannot help with that request."));
          return { usedModel: model.id, usedFamily: model.family };
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
