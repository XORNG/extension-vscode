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
 * - Supports multiple model families (gpt-4o, claude-3.5-sonnet, etc.)
 * - Streaming responses for real-time feedback
 * - Respects VS Code's chat model selection
 */
export class CopilotProvider extends BaseProvider {
  private preferredModelFamily: string;
  private cachedModel: vscode.LanguageModelChat | undefined;

  constructor(modelFamily: string = 'gpt-4o') {
    super('copilot', 'GitHub Copilot');
    this.preferredModelFamily = modelFamily;
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
   * Get available model families
   */
  async getAvailableModels(): Promise<string[]> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    return models.map((m: vscode.LanguageModelChat) => m.family);
  }

  dispose(): void {
    this.cachedModel = undefined;
    super.dispose();
  }
}
