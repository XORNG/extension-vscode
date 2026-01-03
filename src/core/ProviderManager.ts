import * as vscode from 'vscode';
import type { AIProvider, AIProviderType, NativeProviderType, XORNGConfig } from '../types/index.js';
import { CopilotProvider } from '../providers/CopilotProvider.js';
import { NativeProvider } from '../providers/NativeProvider.js';
import { ClaudeProvider, CursorProvider, CodexProvider } from '../providers/FutureProviders.js';

/**
 * ProviderManager - Manages AI provider instances and switching
 * 
 * Handles:
 * - Provider instantiation and lifecycle
 * - Switching between providers (Copilot, Native, Claude, etc.)
 * - Configuration synchronization
 * - Provider availability checking
 */
export class ProviderManager implements vscode.Disposable {
  private providers: Map<AIProviderType, AIProvider> = new Map();
  private currentProviderType: AIProviderType;
  private _onProviderChanged = new vscode.EventEmitter<AIProvider>();
  readonly onProviderChanged = this._onProviderChanged.event;

  constructor() {
    const config = this.getConfig();
    this.currentProviderType = config.provider;
    this.initializeProviders(config);
  }

  /**
   * Get XORNG configuration from VS Code settings
   */
  private getConfig(): XORNGConfig {
    const config = vscode.workspace.getConfiguration('xorng');
    return {
      provider: config.get<AIProviderType>('provider') || 'copilot',
      copilot: {
        modelFamily: config.get<string>('copilot.modelFamily') || 'gpt-4.1',
      },
      native: {
        provider: config.get<NativeProviderType>('native.provider') || 'openai',
        apiKey: config.get<string>('native.apiKey') || '',
      },
      subAgents: {
        enabled: config.get<boolean>('subAgents.enabled') ?? true,
        validators: config.get<string[]>('subAgents.validators') || ['code-review', 'security'],
        knowledge: config.get<string[]>('subAgents.knowledge') || ['documentation', 'best-practices'],
      },
      memory: {
        enabled: config.get<boolean>('memory.enabled') ?? true,
        shortTermTTL: config.get<number>('memory.shortTermTTL') || 3600,
      },
      telemetry: {
        enabled: config.get<boolean>('telemetry.enabled') ?? true,
      },
      logging: {
        level: config.get<string>('logging.level') || 'info',
      },
    };
  }

  /**
   * Initialize all providers
   */
  private initializeProviders(config: XORNGConfig): void {
    // Copilot Provider
    this.providers.set('copilot', new CopilotProvider(config.copilot.modelFamily));

    // Native Provider
    this.providers.set('native', new NativeProvider(
      config.native.provider,
      config.native.apiKey
    ));

    // Future providers (placeholders)
    this.providers.set('claude', new ClaudeProvider());
    this.providers.set('cursor', new CursorProvider());
    this.providers.set('codex', new CodexProvider());
  }

  /**
   * Get the current provider
   */
  getCurrentProvider(): AIProvider {
    const provider = this.providers.get(this.currentProviderType);
    if (!provider) {
      // Fallback to Copilot
      return this.providers.get('copilot')!;
    }
    return provider;
  }

  /**
   * Get the current provider type
   */
  getCurrentProviderType(): AIProviderType {
    return this.currentProviderType;
  }

  /**
   * Get a specific provider by type
   */
  getProvider(type: AIProviderType): AIProvider | undefined {
    return this.providers.get(type);
  }

  /**
   * Get the Copilot provider (convenience method for chat handler)
   */
  getCopilotProvider(): CopilotProvider {
    return this.providers.get('copilot') as CopilotProvider;
  }

  /**
   * Switch to a different provider
   */
  async switchProvider(type: AIProviderType): Promise<boolean> {
    const provider = this.providers.get(type);
    if (!provider) {
      vscode.window.showErrorMessage(`Provider '${type}' not found`);
      return false;
    }

    const available = await provider.isAvailable();
    if (!available) {
      vscode.window.showWarningMessage(
        `Provider '${provider.displayName}' is not available. Check configuration.`
      );
      return false;
    }

    this.currentProviderType = type;
    this._onProviderChanged.fire(provider);

    // Update configuration
    await vscode.workspace.getConfiguration('xorng').update(
      'provider',
      type,
      vscode.ConfigurationTarget.Global
    );

    vscode.window.showInformationMessage(
      `XORNG: Switched to ${provider.displayName}`
    );

    return true;
  }

  /**
   * Toggle between Copilot and Native providers
   */
  async toggleProvider(): Promise<void> {
    const newType = this.currentProviderType === 'copilot' ? 'native' : 'copilot';
    await this.switchProvider(newType);
  }

  /**
   * Check availability of all providers
   */
  async checkAllProviders(): Promise<Map<AIProviderType, boolean>> {
    const availability = new Map<AIProviderType, boolean>();
    
    for (const [type, provider] of this.providers) {
      try {
        availability.set(type, await provider.isAvailable());
      } catch {
        availability.set(type, false);
      }
    }

    return availability;
  }

  /**
   * Get status information for all providers
   */
  async getProvidersStatus(): Promise<Array<{
    type: AIProviderType;
    name: string;
    available: boolean;
    current: boolean;
  }>> {
    const status: Array<{
      type: AIProviderType;
      name: string;
      available: boolean;
      current: boolean;
    }> = [];

    for (const [type, provider] of this.providers) {
      status.push({
        type,
        name: provider.displayName,
        available: await provider.isAvailable(),
        current: type === this.currentProviderType,
      });
    }

    return status;
  }

  /**
   * Update configuration when settings change
   */
  updateConfiguration(): void {
    const config = this.getConfig();

    // Update Copilot provider
    const copilotProvider = this.providers.get('copilot') as CopilotProvider;
    if (copilotProvider) {
      copilotProvider.setModelFamily(config.copilot.modelFamily);
    }

    // Update Native provider
    const nativeProvider = this.providers.get('native') as NativeProvider;
    if (nativeProvider) {
      nativeProvider.configure(
        config.native.provider,
        config.native.apiKey
      );
    }

    // Update current provider if changed
    if (config.provider !== this.currentProviderType) {
      this.switchProvider(config.provider);
    }
  }

  /**
   * Show provider selection quick pick
   */
  async showProviderPicker(): Promise<AIProviderType | undefined> {
    const status = await this.getProvidersStatus();
    
    const items: vscode.QuickPickItem[] = status.map(s => ({
      label: s.current ? `$(check) ${s.name}` : s.name,
      description: s.type,
      detail: s.available ? 'Available' : 'Not available',
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select AI Provider for XORNG',
      title: 'XORNG: Select Provider',
    });

    if (selected) {
      const type = selected.description as AIProviderType;
      await this.switchProvider(type);
      return type;
    }

    return undefined;
  }

  /**
   * Dispose all providers
   */
  dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.providers.clear();
    this._onProviderChanged.dispose();
  }
}
