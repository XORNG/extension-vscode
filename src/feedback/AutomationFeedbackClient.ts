import * as vscode from 'vscode';

/**
 * Feedback types that can be sent to the automation server
 */
export type FeedbackType =
  | 'improvement-accepted'
  | 'improvement-rejected'
  | 'error-report'
  | 'suggestion'
  | 'code-review-result'
  | 'pattern-learned'
  | 'task-completed'
  | 'task-failed'
  | 'rating';

/**
 * Feedback data structure
 */
export interface FeedbackData {
  message?: string;
  rating?: number;
  file?: string;
  language?: string;
  codeSnippet?: string;
  prompt?: string;
  response?: string;
  model?: string;
  taskId?: string;
  issueNumber?: number;
  repository?: string;
  pattern?: {
    name: string;
    description: string;
    example: string;
  };
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
  [key: string]: unknown;
}

/**
 * Telemetry event
 */
export interface TelemetryEvent {
  name: string;
  timestamp: string;
  properties?: Record<string, unknown>;
}

/**
 * Telemetry metric
 */
export interface TelemetryMetric {
  name: string;
  value: number;
  timestamp: string;
  tags?: Record<string, string>;
}

/**
 * Processing task from server
 */
export interface ProcessingTask {
  id: string;
  type: 'issue' | 'pr' | 'feedback';
  status: string;
  priority: number;
  data: unknown;
  createdAt: string;
}

/**
 * AutomationFeedbackClient - Client for communicating with XORNG Automation Server
 * 
 * Provides:
 * - Feedback submission (accepted/rejected suggestions, ratings, errors)
 * - Telemetry reporting
 * - Task retrieval and result submission
 */
export class AutomationFeedbackClient {
  private serverUrl: string | null = null;
  private extensionVersion: string;
  private workspaceId: string;
  private enabled: boolean = false;

  // Telemetry batching
  private pendingEvents: TelemetryEvent[] = [];
  private pendingMetrics: TelemetryMetric[] = [];
  private flushInterval: NodeJS.Timer | null = null;

  constructor(context: vscode.ExtensionContext) {
    this.extensionVersion = vscode.extensions.getExtension('xorng.xorng-vscode')?.packageJSON.version || '0.0.0';
    this.workspaceId = this.generateWorkspaceId();
    
    // Load configuration
    this.updateConfiguration();
    
    // Listen for configuration changes
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('xorng.automation')) {
          this.updateConfiguration();
        }
      })
    );

    // Start telemetry flush interval
    this.flushInterval = setInterval(() => this.flushTelemetry(), 60000); // Every minute
    
    context.subscriptions.push({
      dispose: () => {
        if (this.flushInterval) {
          clearInterval(this.flushInterval);
        }
        this.flushTelemetry(); // Final flush on dispose
      }
    });
  }

  /**
   * Update configuration from VS Code settings
   */
  private updateConfiguration(): void {
    const config = vscode.workspace.getConfiguration('xorng');
    this.serverUrl = config.get<string>('automation.serverUrl') || null;
    this.enabled = config.get<boolean>('automation.feedbackEnabled', true);

    if (this.serverUrl) {
      console.log(`XORNG Feedback: Connected to ${this.serverUrl}`);
    }
  }

  /**
   * Generate a unique workspace identifier
   */
  private generateWorkspaceId(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      // Use hash of workspace folder path
      return this.hashString(folders[0].uri.fsPath);
    }
    return 'no-workspace';
  }

  /**
   * Simple string hash
   */
  private hashString(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  /**
   * Submit feedback to automation server
   */
  async submitFeedback(type: FeedbackType, data: FeedbackData): Promise<boolean> {
    if (!this.enabled || !this.serverUrl) {
      return false;
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/feedback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type,
          data,
          extensionVersion: this.extensionVersion,
          workspaceId: this.workspaceId,
          timestamp: new Date().toISOString(),
        }),
      });

      if (!response.ok) {
        console.warn(`XORNG Feedback: Server returned ${response.status}`);
        return false;
      }

      return true;
    } catch (error) {
      console.error('XORNG Feedback: Failed to submit feedback', error);
      return false;
    }
  }

  /**
   * Report that user accepted an AI improvement
   */
  async reportAccepted(data: {
    prompt: string;
    response: string;
    file?: string;
    rating?: number;
  }): Promise<void> {
    await this.submitFeedback('improvement-accepted', data);
  }

  /**
   * Report that user rejected an AI improvement
   */
  async reportRejected(data: {
    prompt: string;
    response: string;
    file?: string;
    reason?: string;
  }): Promise<void> {
    await this.submitFeedback('improvement-rejected', data);
  }

  /**
   * Report an error
   */
  async reportError(error: Error, context?: Record<string, unknown>): Promise<void> {
    await this.submitFeedback('error-report', {
      error: {
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      },
      ...context,
    });
  }

  /**
   * Submit a user rating
   */
  async submitRating(rating: number, message?: string): Promise<void> {
    await this.submitFeedback('rating', { rating, message });
  }

  /**
   * Report a learned pattern
   */
  async reportPattern(pattern: {
    name: string;
    description: string;
    example: string;
  }): Promise<void> {
    await this.submitFeedback('pattern-learned', { pattern });
  }

  /**
   * Track telemetry event
   */
  trackEvent(name: string, properties?: Record<string, unknown>): void {
    this.pendingEvents.push({
      name,
      timestamp: new Date().toISOString(),
      properties,
    });
  }

  /**
   * Track telemetry metric
   */
  trackMetric(name: string, value: number, tags?: Record<string, string>): void {
    this.pendingMetrics.push({
      name,
      value,
      timestamp: new Date().toISOString(),
      tags,
    });
  }

  /**
   * Flush pending telemetry to server
   */
  private async flushTelemetry(): Promise<void> {
    if (!this.enabled || !this.serverUrl) {
      return;
    }

    if (this.pendingEvents.length === 0 && this.pendingMetrics.length === 0) {
      return;
    }

    const events = [...this.pendingEvents];
    const metrics = [...this.pendingMetrics];
    
    this.pendingEvents = [];
    this.pendingMetrics = [];

    try {
      await fetch(`${this.serverUrl}/api/telemetry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          events,
          metrics,
          extensionVersion: this.extensionVersion,
          workspaceId: this.workspaceId,
        }),
      });
    } catch (error) {
      // Re-add to pending on failure (with limit)
      if (this.pendingEvents.length < 1000) {
        this.pendingEvents.unshift(...events);
      }
      if (this.pendingMetrics.length < 1000) {
        this.pendingMetrics.unshift(...metrics);
      }
    }
  }

  /**
   * Get pending tasks from automation server
   */
  async getPendingTasks(capabilities?: string[]): Promise<ProcessingTask[]> {
    if (!this.enabled || !this.serverUrl) {
      return [];
    }

    try {
      const params = new URLSearchParams({
        workspaceId: this.workspaceId,
      });
      
      if (capabilities) {
        params.set('capabilities', capabilities.join(','));
      }

      const response = await fetch(`${this.serverUrl}/api/pending-tasks?${params}`);
      
      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      return data.tasks || [];
    } catch (error) {
      console.error('XORNG Feedback: Failed to get pending tasks', error);
      return [];
    }
  }

  /**
   * Submit task result to automation server
   */
  async submitTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result?: unknown,
    error?: string
  ): Promise<boolean> {
    if (!this.enabled || !this.serverUrl) {
      return false;
    }

    try {
      const response = await fetch(`${this.serverUrl}/api/task/${taskId}/result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status,
          result,
          error,
          metadata: {
            workspaceId: this.workspaceId,
            extensionVersion: this.extensionVersion,
          },
        }),
      });

      return response.ok;
    } catch (error) {
      console.error('XORNG Feedback: Failed to submit task result', error);
      return false;
    }
  }

  /**
   * Check if feedback is enabled and server is configured
   */
  isEnabled(): boolean {
    return this.enabled && !!this.serverUrl;
  }

  /**
   * Get server URL
   */
  getServerUrl(): string | null {
    return this.serverUrl;
  }
}
