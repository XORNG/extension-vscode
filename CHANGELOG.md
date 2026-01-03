# XORNG VS Code Extension Changelog

All notable changes to this project will be documented in this file.

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
