import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { DockerManager, ServiceStatus } from './DockerManager.js';

const execAsync = promisify(exec);

/**
 * Repository configuration for auto-setup
 */
interface RepoConfig {
  name: string;
  url: string;
  branch: string;
  type: 'core' | 'validator' | 'knowledge' | 'task' | 'template';
  required: boolean;
}

/**
 * Setup state stored in global state
 */
interface SetupState {
  version: string;
  lastSetup: string;
  lastUpdate: string;
  repos: Record<string, {
    installed: boolean;
    version: string;
    lastUpdated: string;
  }>;
}

/**
 * XORNG repository configurations
 */
const REPOS: RepoConfig[] = [
  {
    name: 'core',
    url: 'https://github.com/XORNG/core.git',
    branch: 'main',
    type: 'core',
    required: true,
  },
  {
    name: 'validator-code-review',
    url: 'https://github.com/XORNG/validator-code-review.git',
    branch: 'main',
    type: 'validator',
    required: false,
  },
  {
    name: 'validator-security',
    url: 'https://github.com/XORNG/validator-security.git',
    branch: 'main',
    type: 'validator',
    required: false,
  },
  {
    name: 'knowledge-best-practices',
    url: 'https://github.com/XORNG/knowledge-best-practices.git',
    branch: 'main',
    type: 'knowledge',
    required: false,
  },
  {
    name: 'knowledge-documentation',
    url: 'https://github.com/XORNG/knowledge-documentation.git',
    branch: 'main',
    type: 'knowledge',
    required: false,
  },
];

const SETUP_VERSION = '1.0.0';

/**
 * SetupManager - Handles auto-setup and updates for XORNG components
 */
export class SetupManager implements vscode.Disposable {
  private globalStoragePath: string;
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;
  private disposables: vscode.Disposable[] = [];
  private dockerManager: DockerManager;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.globalStoragePath = context.globalStorageUri.fsPath;
    this.outputChannel = vscode.window.createOutputChannel('XORNG Setup');
    this.disposables.push(this.outputChannel);
    this.dockerManager = new DockerManager(context);
    this.disposables.push(this.dockerManager);
  }

  /**
   * Get the DockerManager instance
   */
  getDockerManager(): DockerManager {
    return this.dockerManager;
  }

  /**
   * Get the installation path for a repository
   */
  getRepoPath(repoName: string): string {
    return path.join(this.globalStoragePath, 'repos', repoName);
  }

  /**
   * Get the Core installation path
   */
  getCorePath(): string {
    return this.getRepoPath('core');
  }

  /**
   * Get all installed sub-agent paths
   */
  getSubAgentPaths(): string[] {
    const paths: string[] = [];
    for (const repo of REPOS) {
      if (repo.type !== 'core') {
        const repoPath = this.getRepoPath(repo.name);
        if (fs.existsSync(repoPath)) {
          paths.push(repoPath);
        }
      }
    }
    return paths;
  }

  /**
   * Get current setup state
   */
  private getSetupState(): SetupState | undefined {
    return this.context.globalState.get<SetupState>('xorng.setupState');
  }

  /**
   * Save setup state
   */
  private async saveSetupState(state: SetupState): Promise<void> {
    await this.context.globalState.update('xorng.setupState', state);
  }

  /**
   * Check if initial setup is needed
   */
  needsSetup(): boolean {
    const state = this.getSetupState();
    if (!state) return true;
    if (state.version !== SETUP_VERSION) return true;
    
    // Check if core is installed
    const corePath = this.getCorePath();
    return !fs.existsSync(corePath);
  }

  /**
   * Check if update is available
   */
  async checkForUpdates(): Promise<boolean> {
    const state = this.getSetupState();
    if (!state) return false;

    // Check if it's been more than 24 hours since last update
    const lastUpdate = new Date(state.lastUpdate);
    const now = new Date();
    const hoursSinceUpdate = (now.getTime() - lastUpdate.getTime()) / (1000 * 60 * 60);
    
    return hoursSinceUpdate > 24;
  }

  /**
   * Run initial setup
   */
  async runSetup(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    this.log('Starting XORNG setup...');

    try {
      // Step 1: Check Docker prerequisites
      progress?.report({ message: 'Checking Docker prerequisites...' });
      
      const dockerAvailable = await this.dockerManager.isDockerAvailable();
      if (!dockerAvailable) {
        const action = await vscode.window.showErrorMessage(
          'Docker is required for XORNG. Please install Docker Desktop or Docker Engine.',
          'Open Docker Install Guide',
          'Cancel'
        );
        if (action === 'Open Docker Install Guide') {
          vscode.env.openExternal(vscode.Uri.parse('https://docs.docker.com/get-docker/'));
        }
        return false;
      }

      const dockerRunning = await this.dockerManager.isDockerRunning();
      if (!dockerRunning) {
        const action = await vscode.window.showErrorMessage(
          'Docker daemon is not running. Please start Docker Desktop or the Docker service.',
          'Retry',
          'Cancel'
        );
        if (action === 'Retry') {
          return this.runSetup(progress);
        }
        return false;
      }

      // Step 2: Start Docker infrastructure services (Redis, etc.)
      progress?.report({ message: 'Starting infrastructure services (Redis)...' });
      this.log('Starting Docker infrastructure services...');
      
      try {
        await this.dockerManager.startServices(progress);
        this.log('✓ Docker infrastructure services started');
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        this.log(`✗ Failed to start Docker services: ${errorMsg}`);
        throw new Error(`Failed to start infrastructure services: ${errorMsg}`);
      }

      // Step 3: Ensure storage directory exists
      await fs.promises.mkdir(path.join(this.globalStoragePath, 'repos'), { recursive: true });

      const totalRepos = REPOS.length;
      let completedRepos = 0;

      const state: SetupState = {
        version: SETUP_VERSION,
        lastSetup: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
        repos: {},
      };

      // Step 4: Clone and setup each repository
      for (const repo of REPOS) {
        const repoPath = this.getRepoPath(repo.name);
        
        progress?.report({
          message: `Setting up ${repo.name}...`,
          increment: (1 / totalRepos) * 70,  // 70% for repos, 30% for docker
        });

        try {
          if (fs.existsSync(repoPath)) {
            // Repository exists, pull latest
            this.log(`Updating ${repo.name}...`);
            await this.gitPull(repoPath);
          } else {
            // Clone repository
            this.log(`Cloning ${repo.name}...`);
            await this.gitClone(repo.url, repoPath, repo.branch);
          }

          // Install npm dependencies
          this.log(`Installing dependencies for ${repo.name}...`);
          await this.npmInstall(repoPath);

          // Build if needed
          if (await this.hasBuildScript(repoPath)) {
            this.log(`Building ${repo.name}...`);
            await this.npmBuild(repoPath);
          }

          // Get version from package.json
          const version = await this.getPackageVersion(repoPath);

          state.repos[repo.name] = {
            installed: true,
            version,
            lastUpdated: new Date().toISOString(),
          };

          completedRepos++;
          this.log(`✓ ${repo.name} setup complete`);

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.log(`✗ Failed to setup ${repo.name}: ${errorMsg}`);
          
          if (repo.required) {
            throw new Error(`Required component ${repo.name} failed to setup: ${errorMsg}`);
          }

          state.repos[repo.name] = {
            installed: false,
            version: '',
            lastUpdated: new Date().toISOString(),
          };
        }
      }

      await this.saveSetupState(state);
      this.log(`Setup complete: ${completedRepos}/${totalRepos} components installed`);
      
      return true;

    } catch (error) {
      this.log(`Setup failed: ${error}`);
      return false;
    }
  }

  /**
   * Run update for all repositories
   */
  async runUpdate(progress?: vscode.Progress<{ message?: string; increment?: number }>): Promise<boolean> {
    this.log('Starting XORNG update...');

    const state = this.getSetupState();
    if (!state) {
      // Need full setup
      return this.runSetup(progress);
    }

    try {
      const installedRepos = REPOS.filter(r => state.repos[r.name]?.installed);
      const totalRepos = installedRepos.length;
      let updatedRepos = 0;

      for (const repo of installedRepos) {
        const repoPath = this.getRepoPath(repo.name);
        
        progress?.report({
          message: `Updating ${repo.name}...`,
          increment: (1 / totalRepos) * 100,
        });

        try {
          // Check for updates
          const hasUpdates = await this.gitHasUpdates(repoPath);
          
          if (hasUpdates) {
            this.log(`Updating ${repo.name}...`);
            await this.gitPull(repoPath);
            await this.npmInstall(repoPath);
            
            if (await this.hasBuildScript(repoPath)) {
              await this.npmBuild(repoPath);
            }

            const version = await this.getPackageVersion(repoPath);
            state.repos[repo.name] = {
              installed: true,
              version,
              lastUpdated: new Date().toISOString(),
            };
            
            updatedRepos++;
            this.log(`✓ ${repo.name} updated`);
          } else {
            this.log(`- ${repo.name} is up to date`);
          }

        } catch (error) {
          this.log(`✗ Failed to update ${repo.name}: ${error}`);
        }
      }

      state.lastUpdate = new Date().toISOString();
      await this.saveSetupState(state);
      
      this.log(`Update complete: ${updatedRepos} components updated`);
      return true;

    } catch (error) {
      this.log(`Update failed: ${error}`);
      return false;
    }
  }

  /**
   * Git clone a repository
   */
  private async gitClone(url: string, targetPath: string, branch: string): Promise<void> {
    await execAsync(`git clone --branch ${branch} --single-branch ${url} "${targetPath}"`);
  }

  /**
   * Git pull latest changes
   */
  private async gitPull(repoPath: string): Promise<void> {
    await execAsync('git pull', { cwd: repoPath });
  }

  /**
   * Check if git repo has updates available
   */
  private async gitHasUpdates(repoPath: string): Promise<boolean> {
    try {
      await execAsync('git fetch', { cwd: repoPath });
      const { stdout } = await execAsync('git status -uno', { cwd: repoPath });
      return stdout.includes('behind');
    } catch {
      return false;
    }
  }

  /**
   * Run npm install
   */
  private async npmInstall(repoPath: string): Promise<void> {
    await execAsync('npm install --production', { cwd: repoPath });
  }

  /**
   * Run npm build
   */
  private async npmBuild(repoPath: string): Promise<void> {
    await execAsync('npm run build', { cwd: repoPath });
  }

  /**
   * Check if package.json has a build script
   */
  private async hasBuildScript(repoPath: string): Promise<boolean> {
    try {
      const packageJson = JSON.parse(
        await fs.promises.readFile(path.join(repoPath, 'package.json'), 'utf-8')
      );
      return !!packageJson.scripts?.build;
    } catch {
      return false;
    }
  }

  /**
   * Get version from package.json
   */
  private async getPackageVersion(repoPath: string): Promise<string> {
    try {
      const packageJson = JSON.parse(
        await fs.promises.readFile(path.join(repoPath, 'package.json'), 'utf-8')
      );
      return packageJson.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Get installed components info
   */
  getInstalledComponents(): Array<{
    name: string;
    type: string;
    installed: boolean;
    version: string;
    path: string;
  }> {
    const state = this.getSetupState();
    
    return REPOS.map(repo => ({
      name: repo.name,
      type: repo.type,
      installed: state?.repos[repo.name]?.installed ?? false,
      version: state?.repos[repo.name]?.version ?? '',
      path: this.getRepoPath(repo.name),
    }));
  }

  /**
   * Start infrastructure services (Docker containers)
   */
  async startInfrastructure(): Promise<boolean> {
    try {
      await this.dockerManager.startServices();
      return true;
    } catch (error) {
      this.log(`Failed to start infrastructure: ${error}`);
      return false;
    }
  }

  /**
   * Stop infrastructure services
   */
  async stopInfrastructure(): Promise<void> {
    await this.dockerManager.stopServices();
  }

  /**
   * Get infrastructure services status
   */
  async getInfrastructureStatus(): Promise<ServiceStatus[]> {
    return this.dockerManager.getServicesStatus();
  }

  /**
   * Check if infrastructure is running
   */
  async isInfrastructureReady(): Promise<boolean> {
    return this.dockerManager.isRedisReady();
  }

  /**
   * Get Redis URL for Core configuration
   */
  getRedisUrl(): string {
    return this.dockerManager.getRedisUrl();
  }

  /**
   * Log message
   */
  private log(message: string): void {
    const timestamp = new Date().toISOString();
    this.outputChannel.appendLine(`[${timestamp}] ${message}`);
  }

  /**
   * Show output channel
   */
  showOutput(): void {
    this.outputChannel.show();
  }

  /**
   * Dispose resources
   */
  dispose(): void {
    this.disposables.forEach(d => d.dispose());
  }
}
