import * as vscode from 'vscode';

/**
 * Supported AI providers for XORNG
 */
export type AIProviderType = 'copilot' | 'native' | 'claude' | 'cursor' | 'codex';

/**
 * Native provider types when not using Copilot
 */
export type NativeProviderType = 'openai' | 'anthropic' | 'local';

/**
 * Sub-agent types supported by XORNG
 */
export type SubAgentType = 'validator' | 'knowledge' | 'task' | 'dynamic';

/**
 * Message role in conversations
 */
export type MessageRole = 'system' | 'user' | 'assistant';

/**
 * A message in the conversation
 */
export interface Message {
  role: MessageRole;
  content: string;
}

/**
 * XORNG extension configuration
 */
export interface XORNGConfig {
  provider: AIProviderType;
  copilot: {
    modelFamily: string;
  };
  native: {
    provider: NativeProviderType;
    apiKey: string;
  };
  subAgents: {
    enabled: boolean;
    validators: string[];
    knowledge: string[];
  };
  memory: {
    enabled: boolean;
    shortTermTTL: number;
  };
  telemetry: {
    enabled: boolean;
  };
  logging: {
    level: string;
  };
}

/**
 * Context for XORNG processing
 */
export interface XORNGContext {
  workspaceFolder?: vscode.Uri;
  currentFile?: vscode.Uri;
  selectedCode?: string;
  recentFiles?: vscode.Uri[];
  conversationHistory?: Message[];
  metadata?: Record<string, unknown>;
}

/**
 * Request to be processed by XORNG
 */
export interface XORNGRequest {
  id: string;
  prompt: string;
  command?: string;
  context?: XORNGContext;
  timestamp: Date;
}

/**
 * Result from a sub-agent
 */
export interface SubAgentResult {
  agentId: string;
  agentName: string;
  agentType: SubAgentType;
  content: string;
  confidence: number;
  tokensUsed: number;
  executionTimeMs: number;
}

/**
 * Response from XORNG processing
 */
export interface XORNGResponse {
  id: string;
  requestId: string;
  content: string;
  subAgentResults?: SubAgentResult[];
  metadata: {
    totalTokensUsed: number;
    totalExecutionTimeMs: number;
    provider: AIProviderType;
    model?: string;
  };
  timestamp: Date;
}

/**
 * Provider capabilities
 */
export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  contextWindow: number;
}

/**
 * AI Provider interface
 * All providers (Copilot, Native, Claude, etc.) must implement this interface
 */
export interface AIProvider {
  /**
   * Get the provider type
   */
  readonly type: AIProviderType;

  /**
   * Get the provider name for display
   */
  readonly displayName: string;

  /**
   * Check if the provider is available and ready
   */
  isAvailable(): Promise<boolean>;

  /**
   * Get provider capabilities
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Send a request to the language model
   */
  sendRequest(
    messages: Message[],
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<ProviderResponse>;

  /**
   * Send a streaming request to the language model
   */
  sendStreamingRequest(
    messages: Message[],
    stream: vscode.ChatResponseStream,
    options?: ProviderRequestOptions,
    token?: vscode.CancellationToken
  ): Promise<void>;

  /**
   * Dispose of any resources
   */
  dispose(): void;
}

/**
 * Options for provider requests
 */
export interface ProviderRequestOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  tools?: vscode.LanguageModelChatTool[];
}

/**
 * Response from a provider
 */
export interface ProviderResponse {
  content: string;
  model?: string;
  tokensUsed?: {
    prompt: number;
    completion: number;
    total: number;
  };
}

/**
 * Memory entry for XORNG
 */
export interface MemoryEntry {
  id: string;
  type: 'short-term' | 'long-term' | 'entity';
  content: string;
  timestamp: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  requestId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: Date;
}

/**
 * Sub-agent status
 */
export type SubAgentStatus = 'idle' | 'busy' | 'error' | 'disconnected';

/**
 * Sub-agent definition
 */
export interface SubAgentDefinition {
  id: string;
  name: string;
  type: SubAgentType;
  description: string;
  capabilities: string[];
  prompts: {
    system: string;
    examples?: string[];
  };
  /** Status when connected to Core */
  status?: SubAgentStatus;
  /** Endpoint when connected to Core */
  endpoint?: string;
}

/**
 * Routing decision for a request
 */
export interface RoutingDecision {
  primaryAgents: string[];
  secondaryAgents: string[];
  parallel: boolean;
  priority: number;
}
