/**
 * IPC Message Types for communication between VS Code Extension and XORNG Core
 * 
 * This module defines the contract for inter-process communication using
 * Node.js child_process.fork() with IPC channel.
 */

// ============================================================================
// Base Message Types
// ============================================================================

export interface IPCMessage {
  type: string;
  id: string;
  timestamp: number;
}

export interface IPCRequest extends IPCMessage {
  payload: unknown;
}

export interface IPCResponse extends IPCMessage {
  requestId: string;
  success: boolean;
  payload?: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// ============================================================================
// LLM Proxy Messages (Sub-agents request LLM access through extension)
// ============================================================================

export interface LLMRequestMessage extends IPCRequest {
  type: 'llm:request';
  payload: {
    messages: LLMMessage[];
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    };
  };
}

export interface LLMStreamRequestMessage extends IPCRequest {
  type: 'llm:stream';
  payload: {
    messages: LLMMessage[];
    options?: {
      model?: string;
      temperature?: number;
      maxTokens?: number;
    };
  };
}

export interface LLMStreamChunkMessage extends IPCMessage {
  type: 'llm:chunk';
  requestId: string;
  payload: {
    content: string;
    done: boolean;
  };
}

export interface LLMResponseMessage extends IPCResponse {
  type: 'llm:response';
  payload: {
    content: string;
    tokensUsed?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

// ============================================================================
// Core Lifecycle Messages
// ============================================================================

export interface CoreReadyMessage extends IPCMessage {
  type: 'core:ready';
  payload: {
    version: string;
    capabilities: string[];
  };
}

export interface CoreShutdownMessage extends IPCMessage {
  type: 'core:shutdown';
  payload: {
    reason: string;
  };
}

export interface CoreHealthMessage extends IPCRequest {
  type: 'core:health';
  payload: Record<string, never>;
}

export interface CoreHealthResponseMessage extends IPCResponse {
  type: 'core:health:response';
  payload: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    uptime: number;
    memoryUsage: number;
    subAgentsLoaded: number;
  };
}

// ============================================================================
// Sub-Agent Messages
// ============================================================================

export interface SubAgentListRequestMessage extends IPCRequest {
  type: 'agents:list';
  payload: {
    type?: 'validator' | 'knowledge' | 'task' | 'dynamic';
  };
}

export interface SubAgentInfo {
  id: string;
  name: string;
  type: 'validator' | 'knowledge' | 'task' | 'dynamic';
  description: string;
  status: 'idle' | 'busy' | 'error' | 'disconnected';
  capabilities: string[];
  version: string;
}

export interface SubAgentListResponseMessage extends IPCResponse {
  type: 'agents:list:response';
  payload: {
    agents: SubAgentInfo[];
  };
}

// ============================================================================
// Process Request Messages (Main orchestration)
// ============================================================================

export interface ProcessRequestMessage extends IPCRequest {
  type: 'process:request';
  payload: {
    prompt: string;
    command?: string;
    context?: {
      projectPath?: string;
      currentFile?: string;
      selectedCode?: string;
      recentFiles?: string[];
      metadata?: Record<string, unknown>;
    };
    options?: {
      preferredAgents?: string[];
      excludeAgents?: string[];
      maxTokens?: number;
      timeout?: number;
      includeMemory?: boolean;
      stream?: boolean;
    };
  };
}

export interface ProcessResponseMessage extends IPCResponse {
  type: 'process:response';
  payload: {
    content: string;
    subAgentResults?: Array<{
      agentId: string;
      agentName: string;
      agentType: string;
      content: string;
      confidence: number;
      tokensUsed: number;
      executionTimeMs: number;
    }>;
    metadata?: {
      totalTokensUsed: number;
      totalExecutionTimeMs: number;
      agentsInvoked: number;
      memoryRetrievals: number;
    };
  };
}

export interface ProcessStreamChunkMessage extends IPCMessage {
  type: 'process:chunk';
  requestId: string;
  payload: {
    content: string;
    agentId?: string;
    done: boolean;
  };
}

// ============================================================================
// Token Tracking Messages
// ============================================================================

export interface TokenUsageRequestMessage extends IPCRequest {
  type: 'tokens:usage';
  payload: Record<string, never>;
}

export interface TokenUsageResponseMessage extends IPCResponse {
  type: 'tokens:usage:response';
  payload: {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    estimatedCost: number;
    dailyUsage: number;
    dailyLimit: number;
  };
}

// ============================================================================
// Memory Messages
// ============================================================================

export interface MemorySearchRequestMessage extends IPCRequest {
  type: 'memory:search';
  payload: {
    query: string;
    limit?: number;
  };
}

export interface MemorySearchResponseMessage extends IPCResponse {
  type: 'memory:search:response';
  payload: {
    results: Array<{
      id: string;
      content: string;
      relevance: number;
      timestamp: number;
    }>;
  };
}

export interface MemoryClearRequestMessage extends IPCRequest {
  type: 'memory:clear';
  payload: {
    type?: 'short-term' | 'long-term' | 'all';
  };
}

// ============================================================================
// Setup/Update Messages
// ============================================================================

export interface SetupStatusMessage extends IPCRequest {
  type: 'setup:status';
  payload: Record<string, never>;
}

export interface SetupStatusResponseMessage extends IPCResponse {
  type: 'setup:status:response';
  payload: {
    coreInstalled: boolean;
    coreVersion: string;
    subAgents: Array<{
      name: string;
      installed: boolean;
      version: string;
      lastUpdated: string;
    }>;
  };
}

// ============================================================================
// Type Guards
// ============================================================================

export function isIPCRequest(msg: unknown): msg is IPCRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    'id' in msg &&
    'timestamp' in msg &&
    'payload' in msg
  );
}

export function isIPCResponse(msg: unknown): msg is IPCResponse {
  return (
    isIPCRequest(msg) &&
    'requestId' in msg &&
    'success' in msg
  );
}

export function isLLMRequest(msg: unknown): msg is LLMRequestMessage {
  return isIPCRequest(msg) && (msg as IPCRequest).type === 'llm:request';
}

export function isLLMStreamRequest(msg: unknown): msg is LLMStreamRequestMessage {
  return isIPCRequest(msg) && (msg as IPCRequest).type === 'llm:stream';
}

// ============================================================================
// Message Factory
// ============================================================================

let messageCounter = 0;

export function createIPCRequest<T extends IPCRequest>(
  type: T['type'],
  payload: T['payload']
): T {
  return {
    type,
    id: `msg_${++messageCounter}_${Date.now()}`,
    timestamp: Date.now(),
    payload,
  } as T;
}

export function createIPCResponse<T extends IPCResponse>(
  type: T['type'],
  requestId: string,
  success: boolean,
  payload?: T['payload'],
  error?: IPCResponse['error']
): T {
  return {
    type,
    id: `res_${++messageCounter}_${Date.now()}`,
    timestamp: Date.now(),
    requestId,
    success,
    payload,
    error,
  } as T;
}
