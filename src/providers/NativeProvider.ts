import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider.js';
import type {
  Message,
  NativeProviderType,
  ProviderCapabilities,
  ProviderRequestOptions,
  ProviderResponse,
} from '../types/index.js';

/**
 * NativeProvider - XORNG's own AI provider integration
 * 
 * This provider allows using external AI APIs directly (OpenAI, Anthropic, etc.)
 * without going through Copilot. Useful for:
 * - Users without Copilot subscription
 * - Self-hosted/local models
 * - Specific model requirements
 */
export class NativeProvider extends BaseProvider {
  private nativeType: NativeProviderType;
  private apiKey: string;
  private baseUrl?: string;

  constructor(
    nativeType: NativeProviderType = 'openai',
    apiKey: string = '',
    baseUrl?: string
  ) {
    super('native', `Native (${nativeType})`);
    this.nativeType = nativeType;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * Check if native provider is available
   */
  async isAvailable(): Promise<boolean> {
    this.checkDisposed();
    
    // For local models, check endpoint availability
    if (this.nativeType === 'local') {
      try {
        const response = await fetch(`${this.baseUrl || 'http://localhost:11434'}/api/tags`);
        return response.ok;
      } catch {
        return false;
      }
    }

    // For cloud providers, check if API key is set
    return !!this.apiKey;
  }

  /**
   * Get native provider capabilities
   */
  getCapabilities(): ProviderCapabilities {
    switch (this.nativeType) {
      case 'openai':
        return {
          streaming: true,
          toolCalling: true,
          vision: true,
          contextWindow: 128000,
        };
      case 'anthropic':
        return {
          streaming: true,
          toolCalling: true,
          vision: true,
          contextWindow: 200000,
        };
      case 'local':
        return {
          streaming: true,
          toolCalling: false,
          vision: false,
          contextWindow: 8192,
        };
      default:
        return {
          streaming: true,
          toolCalling: false,
          vision: false,
          contextWindow: 8192,
        };
    }
  }

  /**
   * Send a non-streaming request
   */
  async sendRequest(
    messages: Message[],
    options?: ProviderRequestOptions,
    _token?: vscode.CancellationToken
  ): Promise<ProviderResponse> {
    this.checkDisposed();

    switch (this.nativeType) {
      case 'openai':
        return this.sendOpenAIRequest(messages, options);
      case 'anthropic':
        return this.sendAnthropicRequest(messages, options);
      case 'local':
        return this.sendLocalRequest(messages, options);
      default:
        throw new Error(`Unknown native provider: ${this.nativeType}`);
    }
  }

  /**
   * Send a streaming request
   */
  async sendStreamingRequest(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions,
    _token?: vscode.CancellationToken
  ): Promise<void> {
    this.checkDisposed();

    switch (this.nativeType) {
      case 'openai':
        await this.streamOpenAIRequest(messages, stream, options);
        break;
      case 'anthropic':
        await this.streamAnthropicRequest(messages, stream, options);
        break;
      case 'local':
        await this.streamLocalRequest(messages, stream, options);
        break;
      default:
        throw new Error(`Unknown native provider: ${this.nativeType}`);
    }
  }

  /**
   * Send request to OpenAI
   */
  private async sendOpenAIRequest(
    messages: Message[],
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || 'gpt-4o',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI error: ${error.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return {
      content: data.choices[0].message.content,
      model: data.model,
      tokensUsed: {
        prompt: data.usage?.prompt_tokens || 0,
        completion: data.usage?.completion_tokens || 0,
        total: data.usage?.total_tokens || 0,
      },
    };
  }

  /**
   * Stream request to OpenAI
   */
  private async streamOpenAIRequest(
    messages: Message[],
    chatStream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions
  ): Promise<void> {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: options?.model || 'gpt-4o',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`OpenAI error: ${error.error?.message || 'Unknown error'}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') break;
          
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              chatStream.markdown(content);
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  }

  /**
   * Send request to Anthropic
   */
  private async sendAnthropicRequest(
    messages: Message[],
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    // Extract system message if present
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options?.model || 'claude-3-5-sonnet-20241022',
        max_tokens: options?.maxTokens || 8192,
        system: systemMessage?.content,
        messages: otherMessages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Anthropic error: ${error.error?.message || 'Unknown error'}`);
    }

    const data = await response.json();
    return {
      content: data.content[0].text,
      model: data.model,
      tokensUsed: {
        prompt: data.usage?.input_tokens || 0,
        completion: data.usage?.output_tokens || 0,
        total: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      },
    };
  }

  /**
   * Stream request to Anthropic
   */
  private async streamAnthropicRequest(
    messages: Message[],
    chatStream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions
  ): Promise<void> {
    const systemMessage = messages.find(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options?.model || 'claude-3-5-sonnet-20241022',
        max_tokens: options?.maxTokens || 8192,
        system: systemMessage?.content,
        messages: otherMessages.map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Anthropic error: ${error.error?.message || 'Unknown error'}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              chatStream.markdown(parsed.delta.text);
            }
          } catch {
            // Skip invalid JSON
          }
        }
      }
    }
  }

  /**
   * Send request to local model (Ollama)
   */
  private async sendLocalRequest(
    messages: Message[],
    options?: ProviderRequestOptions
  ): Promise<ProviderResponse> {
    const baseUrl = this.baseUrl || 'http://localhost:11434';
    
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || 'llama3.2',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local model error: ${response.statusText}`);
    }

    const data = await response.json();
    return {
      content: data.message?.content || '',
      model: data.model,
    };
  }

  /**
   * Stream request to local model (Ollama)
   */
  private async streamLocalRequest(
    messages: Message[],
    chatStream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions
  ): Promise<void> {
    const baseUrl = this.baseUrl || 'http://localhost:11434';
    
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: options?.model || 'llama3.2',
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Local model error: ${response.statusText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value);
      const lines = text.split('\n').filter((l: string) => l.trim());

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            chatStream.markdown(parsed.message.content);
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }

  /**
   * Update configuration
   */
  configure(nativeType: NativeProviderType, apiKey: string, baseUrl?: string): void {
    this.nativeType = nativeType;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }
}
