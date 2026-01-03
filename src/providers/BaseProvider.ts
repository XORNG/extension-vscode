import * as vscode from 'vscode';
import type {
  AIProvider,
  AIProviderType,
  Message,
  ProviderCapabilities,
  ProviderRequestOptions,
  ProviderResponse,
} from '../types/index.js';

/**
 * BaseProvider - Abstract base class for all AI providers
 * 
 * Provides common functionality and enforces the provider interface.
 * All provider implementations (Copilot, Native, Claude, etc.) extend this.
 */
export abstract class BaseProvider implements AIProvider {
  protected _disposed = false;

  constructor(
    public readonly type: AIProviderType,
    public readonly displayName: string
  ) {}

  /**
   * Check if the provider is available
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Get provider capabilities
   */
  abstract getCapabilities(): ProviderCapabilities;

  /**
   * Send a request to the language model
   */
  abstract sendRequest(
    messages: Message[],
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<ProviderResponse>;

  /**
   * Send a streaming request
   */
  abstract sendStreamingRequest(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<void>;

  /**
   * Convert XORNG messages to VS Code LanguageModelChatMessages
   */
  protected toLanguageModelMessages(messages: Message[]): vscode.LanguageModelChatMessage[] {
    return messages.map(msg => {
      switch (msg.role) {
        case 'system':
        case 'user':
          return vscode.LanguageModelChatMessage.User(msg.content);
        case 'assistant':
          return vscode.LanguageModelChatMessage.Assistant(msg.content);
        default:
          return vscode.LanguageModelChatMessage.User(msg.content);
      }
    });
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this._disposed = true;
  }

  /**
   * Check if disposed
   */
  protected checkDisposed(): void {
    if (this._disposed) {
      throw new Error(`Provider ${this.displayName} has been disposed`);
    }
  }
}
