import * as vscode from 'vscode';
import { ProviderManager } from './core/ProviderManager.js';
import { XORNGOrchestrator } from './core/XORNGOrchestrator.js';
import { SetupManager } from './setup/SetupManager.js';

/**
 * XORNG VS Code Extension
 * 
 * Entry point for the XORNG extension that provides:
 * - Chat participant (@xorng) for AI-assisted coding
 * - Provider abstraction (Copilot, Native, Claude, Cursor, Codex)
 * - Sub-agent orchestration for specialized tasks
 * - Memory and context management
 * - Auto-setup and updates of XORNG components
 */

let providerManager: ProviderManager;
let orchestrator: XORNGOrchestrator;
let setupManager: SetupManager;
let statusBarItem: vscode.StatusBarItem;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
  console.log('XORNG extension is activating...');

  // Initialize setup manager with extension context
  setupManager = new SetupManager(context);
  context.subscriptions.push(setupManager);

  // Initialize provider manager
  providerManager = new ProviderManager();
  context.subscriptions.push(providerManager);

  // Initialize orchestrator (without Core path initially)
  orchestrator = new XORNGOrchestrator(providerManager);
  context.subscriptions.push(orchestrator);

  // Create chat participant
  const participant = createChatParticipant(context);

  // Register commands
  registerCommands(context);

  // Create status bar
  createStatusBar(context);

  // Listen for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e: vscode.ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('xorng')) {
        providerManager.updateConfiguration();
        updateStatusBar();
      }
    })
  );

  // Listen for provider changes
  context.subscriptions.push(
    providerManager.onProviderChanged(() => {
      updateStatusBar();
    })
  );

  // Run auto-setup in background
  runAutoSetup(context);

  console.log('XORNG extension activated successfully');
}

/**
 * Run auto-setup for XORNG components
 */
async function runAutoSetup(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('xorng');
  const autoSetup = config.get<boolean>('autoSetup', true);

  if (!autoSetup) {
    console.log('XORNG auto-setup disabled');
    return;
  }

  try {
    // Check if setup is needed
    if (await setupManager.needsSetup()) {
      // First-time setup
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: 'XORNG: Setting up components...',
        },
        async (progress) => {
          progress.report({ message: 'Cloning repositories...' });
          const setupSuccess = await setupManager.runSetup(progress);
          
          if (!setupSuccess) {
            vscode.window.showErrorMessage('XORNG: Setup failed. Check the Output panel for details.');
            return;
          }
          
          // Set Core path and configuration
          const corePath = setupManager.getCorePath();
          if (corePath) {
            orchestrator.setCorePath(corePath);
            orchestrator.setRedisUrl(setupManager.getRedisUrl());
            orchestrator.setLogLevel(config.get<string>('logging.level', 'info'));
            
            // Auto-start Core if enabled
            const autoStart = config.get<boolean>('core.autoStart', true);
            if (autoStart) {
              progress.report({ message: 'Starting XORNG Core...' });
              await orchestrator.startCore();
            }
          }
          
          updateStatusBar();
          vscode.window.showInformationMessage('XORNG: Setup completed successfully');
        }
      );
    } else {
      // Run update for existing installation
      const corePath = setupManager.getCorePath();
      if (corePath) {
        orchestrator.setCorePath(corePath);
        orchestrator.setRedisUrl(setupManager.getRedisUrl());
        orchestrator.setLogLevel(config.get<string>('logging.level', 'info'));
        
        // Ensure Docker infrastructure is running
        const infraReady = await setupManager.isInfrastructureReady();
        if (!infraReady) {
          console.log('Starting Docker infrastructure...');
          await setupManager.startInfrastructure();
        }
        
        // Update in background (pull latest changes)
        setupManager.runUpdate().catch(err => {
          console.warn('XORNG update failed:', err);
        });
        
        // Auto-start Core if enabled
        const autoStart = config.get<boolean>('core.autoStart', true);
        if (autoStart) {
          await orchestrator.startCore();
        }
        
        updateStatusBar();
      }
    }
  } catch (error) {
    console.error('XORNG auto-setup failed:', error);
    vscode.window.showWarningMessage(
      `XORNG: Auto-setup failed. You can try again with the "XORNG: Setup Components" command.`
    );
  }
}

/**
 * Create the XORNG chat participant
 */
function createChatParticipant(context: vscode.ExtensionContext): vscode.ChatParticipant {
  // Create the chat participant
  const participant = vscode.chat.createChatParticipant(
    'xorng.orchestrator',
    async (
      request: vscode.ChatRequest,
      chatContext: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ): Promise<vscode.ChatResult> => {
      return orchestrator.handleChatRequest(request, chatContext, stream, token);
    }
  );

  // Set participant properties
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'xorng-icon.png');

  // Add follow-up provider
  participant.followupProvider = {
    provideFollowups(
      result: vscode.ChatResult,
      _context: vscode.ChatContext,
      _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.ChatFollowup[]> {
      const followups: vscode.ChatFollowup[] = [];
      const metadata = result.metadata as { command?: string } | undefined;

      // Suggest follow-ups based on the command used
      if (metadata?.command === 'review') {
        followups.push(
          { prompt: 'Fix the issues found', label: 'Fix Issues' },
          { prompt: 'Check for security issues', label: 'Security Check', command: 'security' }
        );
      } else if (metadata?.command === 'security') {
        followups.push(
          { prompt: 'Show me how to fix the vulnerabilities', label: 'Show Fixes' },
          { prompt: 'Review the overall code quality', label: 'Code Review', command: 'review' }
        );
      } else if (metadata?.command === 'explain') {
        followups.push(
          { prompt: 'Generate documentation for this code', label: 'Generate Docs' },
          { prompt: 'Suggest improvements', label: 'Improve', command: 'refactor' }
        );
      } else if (metadata?.command === 'refactor') {
        followups.push(
          { prompt: 'Apply these refactoring suggestions', label: 'Apply Changes' },
          { prompt: 'Review the refactored code', label: 'Review', command: 'review' }
        );
      } else {
        // Default follow-ups
        followups.push(
          { prompt: 'Review my code', label: 'Code Review', command: 'review' },
          { prompt: 'Explain this code', label: 'Explain', command: 'explain' }
        );
      }

      return followups;
    },
  };

  context.subscriptions.push(participant);
  return participant;
}

/**
 * Register extension commands
 */
function registerCommands(context: vscode.ExtensionContext): void {
  // Select provider command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.selectProvider', async () => {
      await providerManager.showProviderPicker();
    })
  );

  // Toggle provider command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.toggleProvider', async () => {
      await providerManager.toggleProvider();
    })
  );

  // Show status command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.showStatus', async () => {
      const status = await providerManager.getProvidersStatus();
      const currentProvider = providerManager.getCurrentProvider();

      const message = [
        `**XORNG Status**`,
        ``,
        `Current Provider: ${currentProvider.displayName}`,
        ``,
        `**Available Providers:**`,
        ...status.map(s => `- ${s.name}: ${s.available ? '✅ Available' : '❌ Not available'}${s.current ? ' (current)' : ''}`),
      ].join('\n');

      const selection = await vscode.window.showInformationMessage(
        `XORNG is using ${currentProvider.displayName}`,
        'Change Provider',
        'View Details'
      );

      if (selection === 'Change Provider') {
        await providerManager.showProviderPicker();
      } else if (selection === 'View Details') {
        // Show in output channel
        const outputChannel = vscode.window.createOutputChannel('XORNG');
        outputChannel.appendLine(message.replace(/\*\*/g, ''));
        outputChannel.show();
      }
    })
  );

  // Clear memory command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.clearMemory', async () => {
      orchestrator.clearHistory();
      vscode.window.showInformationMessage('XORNG: Conversation memory cleared');
    })
  );

  // Start Core command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.startCore', async () => {
      if (orchestrator.isCoreRunning()) {
        vscode.window.showInformationMessage('XORNG: Core is already running');
        return;
      }

      const corePath = setupManager.getCorePath();
      if (!corePath) {
        const setup = await vscode.window.showWarningMessage(
          'XORNG: Core is not installed. Would you like to run setup?',
          'Run Setup',
          'Cancel'
        );
        if (setup === 'Run Setup') {
          vscode.commands.executeCommand('xorng.setup');
        }
        return;
      }

      const started = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Starting Core...',
          cancellable: false,
        },
        async (progress) => {
          // Ensure Docker infrastructure is running first
          const infraReady = await setupManager.isInfrastructureReady();
          if (!infraReady) {
            progress.report({ message: 'Starting infrastructure services...' });
            try {
              await setupManager.startInfrastructure();
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              vscode.window.showErrorMessage(`Failed to start infrastructure: ${errorMsg}`);
              return false;
            }
          }

          // Configure and start Core
          orchestrator.setCorePath(corePath);
          orchestrator.setRedisUrl(setupManager.getRedisUrl());
          const config = vscode.workspace.getConfiguration('xorng');
          orchestrator.setLogLevel(config.get<string>('logging.level', 'info'));
          
          progress.report({ message: 'Starting XORNG Core...' });
          return orchestrator.startCore();
        }
      );

      if (started) {
        updateStatusBar();
      }
    })
  );

  // Stop Core command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.stopCore', async () => {
      if (!orchestrator.isCoreRunning()) {
        vscode.window.showInformationMessage('XORNG: Core is not running');
        return;
      }

      await orchestrator.stopCore();
      updateStatusBar();
      vscode.window.showInformationMessage('XORNG: Core stopped');
    })
  );

  // Restart Core command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.restartCore', async () => {
      const localOrchestrator = orchestrator.getLocalOrchestrator();
      if (!localOrchestrator) {
        vscode.window.showWarningMessage('XORNG: Core is not initialized');
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Restarting Core...',
          cancellable: false,
        },
        async () => localOrchestrator.restart()
      );

      updateStatusBar();
      vscode.window.showInformationMessage('XORNG: Core restarted');
    })
  );

  // Setup command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.setup', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Setting up components...',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Setting up XORNG...' });
          await setupManager.runSetup(progress);

          const corePath = setupManager.getCorePath();
          if (corePath) {
            orchestrator.setCorePath(corePath);
            progress.report({ message: 'Starting Core...' });
            await orchestrator.startCore();
          }
        }
      );

      updateStatusBar();
      vscode.window.showInformationMessage('XORNG: Setup completed');
    })
  );

  // Update command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.update', async () => {
      const wasRunning = orchestrator.isCoreRunning();
      
      if (wasRunning) {
        await orchestrator.stopCore();
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Updating components...',
          cancellable: false,
        },
        async (progress) => {
          progress.report({ message: 'Pulling latest changes...' });
          await setupManager.runUpdate(progress);
        }
      );

      if (wasRunning) {
        await orchestrator.startCore();
      }

      updateStatusBar();
      vscode.window.showInformationMessage('XORNG: Update completed');
    })
  );

  // Start Docker infrastructure command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.startInfrastructure', async () => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Starting infrastructure services...',
          cancellable: false,
        },
        async (progress) => {
          try {
            progress.report({ message: 'Starting Docker containers (Redis)...' });
            await setupManager.startInfrastructure();
            return true;
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`XORNG: Failed to start infrastructure: ${errorMsg}`);
            return false;
          }
        }
      );

      if (result) {
        vscode.window.showInformationMessage('XORNG: Infrastructure services started');
      }
    })
  );

  // Stop Docker infrastructure command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.stopInfrastructure', async () => {
      // First stop Core if running
      if (orchestrator.isCoreRunning()) {
        await orchestrator.stopCore();
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Stopping infrastructure services...',
          cancellable: false,
        },
        async () => {
          await setupManager.stopInfrastructure();
        }
      );

      updateStatusBar();
      vscode.window.showInformationMessage('XORNG: Infrastructure services stopped');
    })
  );

  // Show infrastructure status command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.showInfrastructureStatus', async () => {
      const status = await setupManager.getInfrastructureStatus();
      const dockerManager = setupManager.getDockerManager();
      
      const items = status.map(service => ({
        label: `$(${service.running ? 'check' : 'circle-slash'}) ${service.name}`,
        description: service.running ? 'Running' : 'Stopped',
        detail: service.ports?.join(', ') || '',
      }));

      const dockerAvailable = await dockerManager.isDockerAvailable();
      const dockerRunning = await dockerManager.isDockerRunning();

      if (!dockerAvailable) {
        vscode.window.showWarningMessage('XORNG: Docker is not installed');
        return;
      }

      if (!dockerRunning) {
        const action = await vscode.window.showWarningMessage(
          'XORNG: Docker daemon is not running',
          'Retry',
          'Cancel'
        );
        if (action === 'Retry') {
          vscode.commands.executeCommand('xorng.showInfrastructureStatus');
        }
        return;
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Infrastructure Services Status',
        title: 'XORNG Docker Services',
      });

      if (selected) {
        // Could add per-service actions here
      }
    })
  );

  // Show available agents command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.showAgents', async () => {
      const agents = orchestrator.getSubAgents();
      const coreRunning = orchestrator.isCoreRunning();

      if (agents.length === 0) {
        vscode.window.showInformationMessage('XORNG: No sub-agents available');
        return;
      }

      const items = agents.map(agent => ({
        label: `$(${getAgentIcon(agent.type)}) ${agent.name}`,
        description: agent.type,
        detail: `${agent.description}${agent.status ? ` (${agent.status})` : ''}`,
        agent,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: coreRunning ? 'Sub-Agents from XORNG Core' : 'Built-in Sub-Agents (Start Core for more)',
        title: 'XORNG Sub-Agents',
      });

      if (selected) {
        // Show agent details
        const agent = selected.agent;
        vscode.window.showInformationMessage(
          `${agent.name}: ${agent.description}`,
          'Use in Chat'
        ).then(selection => {
          if (selection === 'Use in Chat') {
            // Open chat with agent-specific command
            const commandMap: Record<string, string> = {
              'code-review': 'review',
              'security': 'security',
              'documentation': 'explain',
              'refactoring': 'refactor',
            };
            const command = commandMap[agent.id] || '';
            vscode.commands.executeCommand('workbench.action.chat.open', {
              query: `@xorng ${command ? `/${command} ` : ''}`,
            });
          }
        });
      }
    })
  );

  // Show Core logs command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.showCoreLogs', async () => {
      const localOrchestrator = orchestrator.getLocalOrchestrator();
      if (!localOrchestrator) {
        vscode.window.showInformationMessage('XORNG: Core logs not available. Core has not been started.');
        return;
      }
      // The output channel is managed by LocalOrchestrator
      vscode.commands.executeCommand('workbench.action.output.show', { channel: 'XORNG Core' });
    })
  );

  // Refresh available models command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.refreshModels', async () => {
      const copilotProvider = providerManager.getCopilotProvider();
      
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'XORNG: Detecting available Copilot models...',
          cancellable: false,
        },
        async () => {
          const models = await copilotProvider.getAvailableModelsDetailed();
          
          if (models.length === 0) {
            vscode.window.showWarningMessage('No Copilot models available. Ensure GitHub Copilot is installed and active.');
            return;
          }

          // Create output channel to show model details
          const outputChannel = vscode.window.createOutputChannel('XORNG Models');
          outputChannel.clear();
          outputChannel.appendLine('=== Available Copilot Models ===\n');
          
          for (const model of models) {
            outputChannel.appendLine(`📦 ${model.family}`);
            outputChannel.appendLine(`   ID: ${model.id}`);
            outputChannel.appendLine(`   Name: ${model.name}`);
            outputChannel.appendLine(`   Version: ${model.version}`);
            outputChannel.appendLine(`   Max Input Tokens: ${model.maxInputTokens.toLocaleString()}`);
            outputChannel.appendLine('');
          }
          
          outputChannel.appendLine(`\nTotal: ${models.length} models detected`);
          outputChannel.appendLine('\nUse "XORNG: Select Copilot Model" to change your preferred model.');
          outputChannel.show();
          
          vscode.window.showInformationMessage(
            `XORNG: Found ${models.length} Copilot models`,
            'Select Model'
          ).then(selection => {
            if (selection === 'Select Model') {
              vscode.commands.executeCommand('xorng.selectModel');
            }
          });
        }
      );
    })
  );

  // Select Copilot model command
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.selectModel', async () => {
      const copilotProvider = providerManager.getCopilotProvider();
      const models = await copilotProvider.getAvailableModelsDetailed();
      
      if (models.length === 0) {
        vscode.window.showWarningMessage('No Copilot models available. Please run "XORNG: Refresh Available Models".');
        return;
      }

      const config = vscode.workspace.getConfiguration('xorng');
      const currentModel = config.get<string>('copilot.modelFamily') || 'gpt-4.1';

      const items = models.map(model => ({
        label: `$(symbol-misc) ${model.family}`,
        description: model.name,
        detail: `Max tokens: ${model.maxInputTokens.toLocaleString()} | Version: ${model.version}`,
        family: model.family,
        picked: model.family === currentModel,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Copilot model',
        title: 'XORNG: Select Copilot Model',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        await config.update('copilot.modelFamily', selected.family, vscode.ConfigurationTarget.Global);
        copilotProvider.setModelFamily(selected.family);
        vscode.window.showInformationMessage(`XORNG: Switched to ${selected.family}`);
        updateStatusBar();
      }
    })
  );

  // Diagnostic command to show task-specific model configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('xorng.showModelConfig', async () => {
      const config = vscode.workspace.getConfiguration('xorng');
      const useTaskSpecific = config.get<boolean>('copilot.useTaskSpecificModels') || false;
      const taskModels = config.get<Record<string, string>>('copilot.taskModels') || {};
      const defaultModel = config.get<string>('copilot.modelFamily') || 'gpt-4.1';

      const outputChannel = vscode.window.createOutputChannel('XORNG Model Config');
      outputChannel.clear();
      outputChannel.appendLine('=== XORNG Model Configuration ===\n');
      outputChannel.appendLine(`Task-Specific Models Enabled: ${useTaskSpecific ? '✅ YES' : '❌ NO'}`);
      outputChannel.appendLine(`Default Model Family: ${defaultModel}`);
      outputChannel.appendLine('');
      outputChannel.appendLine('Task-specific Model Mapping:');
      outputChannel.appendLine('----------------------------');
      
      const commands = ['review', 'security', 'explain', 'refactor', 'default'];
      for (const cmd of commands) {
        const model = taskModels[cmd] || '(not configured)';
        outputChannel.appendLine(`  /${cmd}: ${model}`);
      }
      
      outputChannel.appendLine('');
      outputChannel.appendLine('How to enable task-specific models:');
      outputChannel.appendLine('1. Set "xorng.copilot.useTaskSpecificModels": true in settings');
      outputChannel.appendLine('2. Configure "xorng.copilot.taskModels" with your preferred models');
      outputChannel.appendLine('');
      outputChannel.appendLine('Available commands: /review, /security, /explain, /refactor');
      outputChannel.appendLine('');
      
      // Also show available models
      const copilotProvider = providerManager.getCopilotProvider();
      const availableModels = await copilotProvider.getAvailableModelsDetailed();
      
      outputChannel.appendLine('Available Copilot Model Families:');
      outputChannel.appendLine('---------------------------------');
      for (const model of availableModels) {
        outputChannel.appendLine(`  - ${model.family} (${model.name})`);
      }
      
      outputChannel.show();
      
      if (!useTaskSpecific) {
        const enable = await vscode.window.showInformationMessage(
          'Task-specific models are currently DISABLED. Would you like to enable them?',
          'Enable',
          'View Config'
        );
        
        if (enable === 'Enable') {
          await config.update('copilot.useTaskSpecificModels', true, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage('XORNG: Task-specific models enabled!');
        } else if (enable === 'View Config') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'xorng.copilot');
        }
      }
    })
  );
}

/**
 * Get icon for agent type
 */
function getAgentIcon(type: string): string {
  switch (type) {
    case 'validator':
      return 'shield';
    case 'knowledge':
      return 'book';
    case 'task':
      return 'tools';
    case 'dynamic':
      return 'sparkle';
    default:
      return 'robot';
  }
}

/**
 * Create status bar item
 */
function createStatusBar(context: vscode.ExtensionContext): void {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );

  statusBarItem.command = 'xorng.selectProvider';
  updateStatusBar();
  statusBarItem.show();

  context.subscriptions.push(statusBarItem);
}

/**
 * Update status bar with current provider and Core status
 */
function updateStatusBar(): void {
  const provider = providerManager.getCurrentProvider();
  const providerType = providerManager.getCurrentProviderType();
  const coreRunning = orchestrator.isCoreRunning();

  let icon = '$(hubot)';
  switch (providerType) {
    case 'copilot':
      icon = '$(copilot)';
      break;
    case 'native':
      icon = '$(server)';
      break;
    case 'claude':
      icon = '$(sparkle)';
      break;
    case 'cursor':
      icon = '$(symbol-cursor)';
      break;
  }

  const coreIndicator = coreRunning ? '$(vm-running)' : '';
  statusBarItem.text = `${icon} XORNG${coreIndicator ? ` ${coreIndicator}` : ''}`;
  statusBarItem.tooltip = `XORNG: ${provider.displayName}\n${coreRunning ? '🟢 Core running' : '⚪ Core stopped'}\nClick to change provider`;
}

/**
 * Extension deactivation
 */
export async function deactivate(): Promise<void> {
  console.log('XORNG extension deactivating...');
  
  // Stop Core gracefully
  if (orchestrator?.isCoreRunning()) {
    await orchestrator.stopCore();
  }
}
