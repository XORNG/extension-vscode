# XORNG VS Code Extension

AI orchestration framework for enhanced coding assistance with GitHub Copilot, Claude, Cursor, and other AI providers. **Now with full codebase access!**

## Features

### 🗂️ Full Codebase Access

XORNG can now access your entire codebase, similar to GitHub Copilot. This enables:

- **Reading files** - Access any file in your workspace
- **Searching code** - Find text patterns across all files
- **Symbol navigation** - Find functions, classes, and variables
- **File tree exploration** - Understand project structure
- **Reference resolution** - Process files and selections you attach to chat

#### Language Model Tools

XORNG registers the following tools that AI models can use to explore your codebase:

| Tool | Description |
|------|-------------|
| `#readFile` | Read contents of any file |
| `#findFiles` | Find files matching glob patterns |
| `#searchWorkspace` | Search text in workspace files |
| `#getSymbols` | Get code symbols (functions, classes, etc.) |
| `#fileTree` | Get workspace file structure |
| `#getFileLines` | Read specific line ranges |
| `#openFiles` | Get currently open/visible files |
| `#currentEditor` | Get active editor context and selection |

### 🤖 Multi-Provider Support

XORNG allows you to seamlessly switch between different AI providers:

- **GitHub Copilot** (Default) - Leverages your existing Copilot subscription
- **Native Providers** - Direct integration with OpenAI, Anthropic, or local models (Ollama)
- **Claude Code** - Integration with Anthropic's Claude (when available)
- **Cursor AI** - Integration with Cursor's AI (when available)
- **OpenAI Codex** - Legacy support (deprecated)

### 💬 Chat Participant

Use `@xorng` in VS Code's chat to access intelligent AI assistance:

```
@xorng Review this code for issues
@xorng /review Check my implementation
@xorng /security Analyze for vulnerabilities
@xorng /explain What does this function do?
@xorng /refactor Improve this code structure
@xorng /config Help me configure XORNG
```

**Attach files and selections:** You can attach files to your chat using `#file:path/to/file.ts` or by selecting code and including it. XORNG will automatically include the content in the context.

### 🔧 Slash Commands

| Command | Description |
|---------|-------------|
| `/review` | Code review for quality, bugs, and best practices |
| `/security` | Security vulnerability analysis |
| `/explain` | Code explanation and documentation |
| `/refactor` | Code improvement suggestions |
| `/config` | Configuration assistance |

### 🎯 Specialized System Prompts

Each slash command uses a specialized system prompt optimized for that task:
- `/review` - Focuses on code quality, bugs, performance, and best practices
- `/security` - Analyzes for vulnerabilities with severity ratings
- `/explain` - Breaks down complex logic with clear explanations
- `/refactor` - Applies SOLID principles and suggests cleaner implementations

> **Note:** Full sub-agent container orchestration requires XORNG Core (coming soon).

## Installation

### From VS Code Marketplace

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "XORNG"
4. Click Install

### From Source

```bash
cd extension-vscode
npm install
npm run build
code --install-extension xorng-vscode-0.1.0.vsix
```

## Configuration

### Provider Selection

1. Click the XORNG status bar item (bottom right)
2. Or run command: `XORNG: Select AI Provider`
3. Choose your preferred provider

### Settings

Configure XORNG in VS Code settings (`Ctrl+,`):

```json
{
  // AI Provider selection
  "xorng.provider": "copilot",  // copilot | native | claude | cursor | codex
  
  // Copilot settings (when using Copilot)
  "xorng.copilot.modelFamily": "gpt-4o",  // gpt-4o | gpt-4o-mini | o1 | claude-3.5-sonnet
  
  // Native provider settings (when using native)
  "xorng.native.provider": "openai",  // openai | anthropic | local
  "xorng.native.apiKey": "",  // Your API key (stored securely)
  
  // Memory settings
  "xorng.memory.enabled": true,
  
  // Telemetry
  "xorng.telemetry.enabled": true,
  
  // Logging
  "xorng.logging.level": "info"  // debug | info | warn | error
}
```

## Usage Examples

### Code Review

```
@xorng /review

Please review this authentication handler:

async function authenticate(req, res) {
  const { username, password } = req.body;
  const user = await User.findOne({ username });
  if (user && user.password === password) {
    return { token: generateToken(user) };
  }
  throw new Error('Invalid credentials');
}
```

### Security Analysis

```
@xorng /security

Check this API endpoint for vulnerabilities:

app.get('/user/:id', async (req, res) => {
  const query = `SELECT * FROM users WHERE id = ${req.params.id}`;
  const user = await db.query(query);
  res.json(user);
});
```

### Code Explanation

```
@xorng /explain

What does this regex do and when would you use it?

const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
```

### Refactoring

```
@xorng /refactor

Suggest improvements for this function:

function processData(data) {
  let result = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i].active == true) {
      if (data[i].value > 0) {
        result.push(data[i].value * 2);
      }
    }
  }
  return result;
}
```

## Provider Details

### GitHub Copilot (Recommended)

Uses your existing GitHub Copilot subscription through VS Code's Language Model API:

- No additional API keys required
- Supports model selection (GPT-4o, Claude, etc.)
- Respects VS Code's model picker
- Rate limits managed by Copilot

### Native Providers

Direct API integration when you don't have Copilot:

**OpenAI:**
```json
{
  "xorng.provider": "native",
  "xorng.native.provider": "openai",
  "xorng.native.apiKey": "sk-..."
}
```

**Anthropic:**
```json
{
  "xorng.provider": "native",
  "xorng.native.provider": "anthropic",
  "xorng.native.apiKey": "sk-ant-..."
}
```

**Local (Ollama):**
```json
{
  "xorng.provider": "native",
  "xorng.native.provider": "local"
  // Uses http://localhost:11434 by default
}
```

## Commands

| Command | Description |
|---------|-------------|
| `XORNG: Select AI Provider` | Choose AI provider |
| `XORNG: Toggle Between Copilot and Native Mode` | Quick switch |
| `XORNG: Show Status` | View current configuration |
| `XORNG: Clear Conversation Memory` | Reset in-session conversation history |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    XORNG VS Code Extension                   │
├─────────────────────────────────────────────────────────────┤
│  Chat Participant (@xorng)                                   │
│  ├── /review, /security, /explain, /refactor, /config       │
│  └── Context-aware responses with follow-ups                 │
├─────────────────────────────────────────────────────────────┤
│  Provider Manager                                            │
│  ├── CopilotProvider (GitHub Copilot LM API)                │
│  ├── NativeProvider (OpenAI, Anthropic, Local)              │
│  ├── ClaudeProvider (placeholder)                            │
│  ├── CursorProvider (placeholder)                            │
│  └── CodexProvider (deprecated)                              │
├─────────────────────────────────────────────────────────────┤
│  XORNG Orchestrator                                          │
│  ├── Request routing to sub-agents                           │
│  ├── Context management                                      │
│  └── Response aggregation                                    │
└─────────────────────────────────────────────────────────────┘
```

## Development

### Prerequisites

- Node.js 18+
- VS Code 1.95+
- TypeScript 5.3+

### Setup

```bash
# Clone the repository
git clone https://github.com/XORNG/extension-vscode

# Install dependencies
cd extension-vscode
npm install

# Build
npm run build

# Watch mode for development
npm run watch
```

### Testing

```bash
# Run in VS Code Extension Development Host
# Press F5 in VS Code with the extension folder open
```

### Packaging

```bash
npm run package
# Creates xorng-vscode-{version}.vsix
```

## Contributing

See the main [XORNG repository](https://github.com/XORNG) for contribution guidelines.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Related Projects

- [XORNG Core](../core) - Central orchestration engine
- [XORNG Node](../node) - AI provider abstraction
- [XORNG Documentation](../documentation) - Full documentation

## Roadmap

- [ ] Full Claude Code integration
- [ ] Cursor AI integration
- [ ] MCP server support
- [ ] Advanced memory with embeddings
- [ ] Custom sub-agent creation
- [ ] Team configuration sharing
- [ ] Token usage analytics
