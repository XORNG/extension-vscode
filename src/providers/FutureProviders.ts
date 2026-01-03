import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider.js';
import type {
  Message,
  ProviderCapabilities,
  ProviderRequestOptions,
  ProviderResponse,
} from '../types/index.js';

/**
 * ClaudeProvider - Claude Code Integration Provider (Placeholder)
 * 
 * This provider will integrate with Claude Code when it becomes available
 * as a VS Code extension or API. Currently serves as a placeholder that
 * falls back to using VS Code's Language Model API if Claude models are available.
 */
export class ClaudeProvider extends BaseProvider {
  constructor() {
    super('claude', 'Claude Code');
  }

  async isAvailable(): Promise<boolean> {
    this.checkDisposed();
    try {
      // Check if Claude models are available through VS Code LM API
      const models = await vscode.lm.selectChatModels({ family: 'claude-3.5-sonnet' });
      return models.length > 0;
    } catch {
      return false;
    }
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      vision: true,
      contextWindow: 200000,
    };
  }

  async sendRequest(
    messages: Message[],
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<ProviderResponse> {
    this.checkDisposed();

    const models = await vscode.lm.selectChatModels({ family: 'claude-3.5-sonnet' });
    if (models.length === 0) {
      throw new Error('Claude models not available. Please ensure Claude Code extension is installed.');
    }

    const model = models[0];
    const lmMessages = this.toLanguageModelMessages(messages);
    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    const response = await model.sendRequest(lmMessages, {}, cancellationToken);
    
    let content = '';
    for await (const fragment of response.text) {
      content += fragment;
    }

    return {
      content,
      model: model.id,
    };
  }

  async sendStreamingRequest(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<void> {
    this.checkDisposed();

    const models = await vscode.lm.selectChatModels({ family: 'claude-3.5-sonnet' });
    if (models.length === 0) {
      throw new Error('Claude models not available. Please ensure Claude Code extension is installed.');
    }

    const model = models[0];
    const lmMessages = this.toLanguageModelMessages(messages);
    const cancellationToken = token || new vscode.CancellationTokenSource().token;

    const response = await model.sendRequest(lmMessages, {}, cancellationToken);
    
    for await (const fragment of response.text) {
      stream.markdown(fragment);
    }
  }
}

/**
 * CursorProvider - Cursor AI Integration Provider (Placeholder)
 * 
 * This provider will integrate with Cursor's AI capabilities when an API
 * becomes available. Currently serves as a placeholder.
 */
export class CursorProvider extends BaseProvider {
  constructor() {
    super('cursor', 'Cursor AI');
  }

  async isAvailable(): Promise<boolean> {
    this.checkDisposed();
    // Cursor integration would check for Cursor-specific APIs
    // For now, return false as it's not yet implemented
    return false;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: true,
      toolCalling: true,
      vision: false,
      contextWindow: 128000,
    };
  }

  async sendRequest(
    _messages: Message[],
    _options?: ProviderRequestOptions,
    _token?: vscode.CancellationToken
  ): Promise<ProviderResponse> {
    this.checkDisposed();
    throw new Error('Cursor provider is not yet implemented. Please use Copilot or Native provider.');
  }

  async sendStreamingRequest(
    _messages: Message[],
    stream: vscode.ChatResponseStream,
    _options?: ProviderRequestOptions,
    _token?: vscode.CancellationToken
  ): Promise<void> {
    this.checkDisposed();
    stream.markdown('⚠️ Cursor provider is not yet implemented. Please use Copilot or Native provider.');
  }
}

/**
 * CodexProvider - OpenAI Codex Integration Provider (Placeholder)
 * 
 * This provider will integrate with OpenAI Codex for code-specific tasks.
 * Currently serves as a placeholder that could fall back to the native provider.
 */
export class CodexProvider extends BaseProvider {
  constructor() {
    super('codex', 'OpenAI Codex');
  }

  async isAvailable(): Promise<boolean> {
    this.checkDisposed();
    // Codex is deprecated, but this could be used for future code-specific models
    return false;
  }

  getCapabilities(): ProviderCapabilities {
    return {
      streaming: false,
      toolCalling: false,
      vision: false,
      contextWindow: 8000,
    };
  }

  async sendRequest(
    _messages: Message[],
    _options?: ProviderRequestOptions,
    _token?: vscode.CancellationToken
  ): Promise<ProviderResponse> {
    this.checkDisposed();
    throw new Error('Codex provider is not available. OpenAI Codex has been deprecated. Please use Copilot or Native provider.');
  }

  async sendStreamingRequest(
    _messages: Message[],
    stream: vscode.ChatResponseStream,
    _options?: ProviderRequestOptions,
    _token?: vscode.CancellationToken
  ): Promise<void> {
    this.checkDisposed();
    stream.markdown('⚠️ Codex provider is not available. OpenAI Codex has been deprecated. Please use Copilot or Native provider.');
  }
}
