# XORNG VS Code Extension Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-01-03

### Added - Full Codebase Access

- **WorkspaceContextManager** - New service for comprehensive workspace access
- **Language Model Tools** - 8 tools for AI models to explore the codebase:
  - `xorng_readFile` - Read file contents from workspace
  - `xorng_findFiles` - Find files matching glob patterns
  - `xorng_searchWorkspace` - Search text/patterns in workspace
  - `xorng_getSymbols` - Get code symbols from files or workspace
  - `xorng_getFileTree` - Get workspace file/folder structure
  - `xorng_getFileContent` - Read specific line ranges from files
  - `xorng_getOpenFiles` - Get currently open/visible files
  - `xorng_getCurrentEditor` - Get active editor context and selection
- **Chat Reference Resolution** - Process files and selections attached to chat messages
- **Enhanced System Prompts** - Updated prompts to inform AI about codebase access capabilities

### Changed

- **XORNGOrchestrator** now accepts WorkspaceContextManager for codebase access
- System prompts now include information about available workspace tools
- Message building includes resolved references from chat requests

### Technical Details

- New `workspace/` module with WorkspaceContextManager
- New `tools/` module with Language Model Tool implementations
- `languageModelTools` contribution point in package.json
- Type definitions for workspace context in types/index.ts

---

## [0.1.0] - 2026-01-03

### Added

- Initial release of XORNG VS Code Extension
- Chat participant `@xorng` with GitHub Copilot integration
- Multi-provider support:
  - GitHub Copilot (default, uses VS Code Language Model API)
  - Native providers (OpenAI, Anthropic, Local/Ollama)
  - Placeholder support for Claude, Cursor, and Codex
- Slash commands for specialized tasks:
  - `/review` - Code review
  - `/security` - Security analysis
  - `/explain` - Code explanation
  - `/refactor` - Refactoring suggestions
  - `/config` - Configuration help
- Provider switching via status bar and commands
- Context-aware responses (uses selected code, current file)
- Conversation history support
- Follow-up suggestions based on command context
- Configuration options for providers, sub-agents, memory, and logging
- Status bar item showing current provider

### Technical Details

- TypeScript implementation with ES2022 target
- Provider abstraction layer for extensibility
- Streaming response support
- VS Code 1.95+ compatibility
- Integration with VS Code's Language Model API
