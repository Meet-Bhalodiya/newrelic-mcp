# MCP client configuration

Choose exactly one transport per client entry. Stdio is simplest for one local user.
Streamable HTTP is appropriate for a managed service and must use bearer or OIDC
authentication beyond loopback. This server does not provide the legacy SSE
transport.

Never commit a New Relic key or MCP bearer token. Pin the npm package version in
managed environments and update it through review.

## Claude Code

### Local stdio through the CLI

Claude Code requires all `claude mcp add` options before the server name:

```bash
claude mcp add --transport stdio --scope user \
  --env NEW_RELIC_API_KEY="$NEW_RELIC_API_KEY" \
  --env NEW_RELIC_REGION=US \
  --env NEW_RELIC_ACCOUNT_ALLOWLIST=1234567 \
  newrelic -- npx -y @meet-bhalodiya/newrelic-mcp@1.0.0

claude mcp get newrelic
claude mcp list
```

Use `--scope local` (the default) for only the current project, `--scope project`
to generate a team-shared `.mcp.json`, or `--scope user` for all your projects.

### Project `.mcp.json`

[`examples/claude-code.mcp.json`](../examples/claude-code.mcp.json) uses Claude
Code's `${VAR}` expansion. Required variables without a default cause config parsing
to fail, which is safer than launching without a key.

```json
{
  "mcpServers": {
    "newrelic": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@meet-bhalodiya/newrelic-mcp@1.0.0"],
      "env": {
        "NEW_RELIC_API_KEY": "${NEW_RELIC_API_KEY}",
        "NEW_RELIC_REGION": "${NEW_RELIC_REGION:-US}",
        "NEW_RELIC_ACCOUNT_ALLOWLIST": "${NEW_RELIC_ACCOUNT_ALLOWLIST}"
      }
    }
  }
}
```

Claude Code asks before trusting a project-scoped server. Use `/mcp` to inspect its
status. The server name `workspace` is reserved; use `newrelic`.

### Remote HTTP

Static bearer (the CLI command writes the header into private user configuration):

```bash
claude mcp add --transport http --scope user \
  --header "Authorization: Bearer $NEW_RELIC_MCP_TOKEN" \
  newrelic https://newrelic-mcp.example.com/mcp
```

For OIDC, omit the header, add the URL, then use `/mcp` and complete authentication:

```bash
claude mcp add --transport http --scope user \
  newrelic https://newrelic-mcp.example.com/mcp
```

## Claude Desktop

### MCPB local installation

The recommended local flow is a signed/reviewed MCPB bundle:

1. Build the project and stage `dist`, production dependencies, `package.json`, and
   a `manifest.json` generated from `mcpb.json`.
2. Run `mcpb validate manifest.json` and `mcpb pack` using the official MCPB CLI.
3. In Claude Desktop, open **Settings → Extensions → Advanced settings → Install
   Extension** and select the `.mcpb` file.
4. Enter the New Relic key in the sensitive field; Claude Desktop stores sensitive
   extension settings in the OS credential store.

### Manual local JSON

On macOS the file is
`~/Library/Application Support/Claude/claude_desktop_config.json`. Merge the
`mcpServers.newrelic` entry from
[`examples/claude-desktop.json`](../examples/claude-desktop.json), replace the
placeholder locally, restrict file permissions, and restart Claude Desktop. This
manual JSON format stores the key in plaintext; prefer MCPB.

### Remote connector

Add a remote server through **Settings → Connectors** and enter
`https://newrelic-mcp.example.com/mcp`. Do not put a remote server in
`claude_desktop_config.json`; Claude Desktop's remote connector flow is managed in
the UI. Hosted custom connectors require OAuth, so deploy OIDC mode and complete
the browser authorization flow.

## Cursor

Cursor loads project configuration from `.cursor/mcp.json` and global configuration
from `~/.cursor/mcp.json`.

Local stdio:

```json
{
  "mcpServers": {
    "newrelic": {
      "command": "npx",
      "args": ["-y", "@meet-bhalodiya/newrelic-mcp@1.0.0"],
      "env": {
        "NEW_RELIC_API_KEY": "${env:NEW_RELIC_API_KEY}",
        "NEW_RELIC_REGION": "US"
      }
    }
  }
}
```

Remote OIDC:

```json
{
  "mcpServers": {
    "newrelic": {
      "url": "https://newrelic-mcp.example.com/mcp"
    }
  }
}
```

The URL selects Streamable HTTP. Omit `type`: current `cursor-agent` releases accept
`http` but can discard a configuration containing the otherwise common
`streamable-http` alias. Omitting it works in both Cursor IDE and CLI.

Authenticate from Cursor's MCP settings or run
`cursor-agent mcp login newrelic`. Environment interpolation is evaluated from the
Cursor process environment; on desktop Linux/macOS, launching Cursor outside a
shell may not inherit shell-profile variables. Use Cursor/OS secret management for
team deployments and never commit expanded values.

## Codex

Codex CLI, Codex IDE extension, and the ChatGPT desktop app on the same Codex host
share MCP configuration. The default file is `~/.codex/config.toml`; a trusted
project can use `.codex/config.toml`.

### Local stdio

```bash
codex mcp add newrelic \
  --env NEW_RELIC_REGION=US \
  --env NEW_RELIC_API_KEY="$NEW_RELIC_API_KEY" \
  -- npx -y @meet-bhalodiya/newrelic-mcp@1.0.0
codex mcp list
```

For configuration that forwards a value from the environment without writing it
into TOML:

```toml
[mcp_servers.newrelic]
command = "npx"
args = ["-y", "@meet-bhalodiya/newrelic-mcp@1.0.0"]
env_vars = ["NEW_RELIC_API_KEY", "NEW_RELIC_ACCOUNT_ALLOWLIST"]
required = true
startup_timeout_sec = 15
tool_timeout_sec = 90
default_tools_approval_mode = "prompt"

[mcp_servers.newrelic.env]
NEW_RELIC_REGION = "US"
```

### Remote static bearer

```bash
export NEW_RELIC_MCP_TOKEN='...'
codex mcp add newrelic \
  --url https://newrelic-mcp.example.com/mcp \
  --bearer-token-env-var NEW_RELIC_MCP_TOKEN
```

Equivalent TOML:

```toml
[mcp_servers.newrelic]
url = "https://newrelic-mcp.example.com/mcp"
bearer_token_env_var = "NEW_RELIC_MCP_TOKEN"
required = true
tool_timeout_sec = 90
default_tools_approval_mode = "prompt"
```

### Remote OAuth

```toml
[mcp_servers.newrelic]
url = "https://newrelic-mcp.example.com/mcp"
required = true
default_tools_approval_mode = "prompt"
```

Then authenticate and inspect:

```bash
codex mcp login newrelic --scopes newrelic:read
codex mcp list
```

Use `/mcp` in the Codex TUI. Server instructions and tools are the core supported
surface; resource and prompt rendering can differ between Codex clients.

## Generic stdio client

Most clients accept a structure similar to this, but field names are not universal:

```json
{
  "command": "npx",
  "args": ["-y", "@meet-bhalodiya/newrelic-mcp@1.0.0"],
  "env": {
    "NEW_RELIC_API_KEY": "NRAK-REPLACE_LOCALLY",
    "NEW_RELIC_REGION": "US"
  }
}
```

Use direct process spawning, not a shell string. This prevents command injection
through arguments and gives the client reliable stdio framing.

## MCP Inspector

Inspect a local build with UI mode:

```bash
npm run build
npx -y @modelcontextprotocol/inspector \
  -e NEW_RELIC_API_KEY="$NEW_RELIC_API_KEY" \
  -e NEW_RELIC_REGION=US \
  -- node dist/cli.js stdio
```

List tools in CLI mode:

```bash
npx -y @modelcontextprotocol/inspector --cli \
  -e NEW_RELIC_API_KEY="$NEW_RELIC_API_KEY" \
  node dist/cli.js stdio --method tools/list
```

For authenticated HTTP:

```bash
npx -y @modelcontextprotocol/inspector@latest --cli \
  https://newrelic-mcp.example.com/mcp \
  --transport http --method tools/list \
  --header "Authorization: Bearer $NEW_RELIC_MCP_TOKEN"
```

The Inspector proxy can spawn local processes. Leave its authentication enabled
and bind it only to localhost.

## Verification checklist

1. `connection_check` succeeds without exposing user email or credentials.
2. `accounts_list` returns only expected allowlisted accounts.
3. `tools/list` contains no write/admin/preview/experimental tools unless intended.
4. A safe NRQL query returns `structuredContent` and JSON text with matching data.
5. A disallowed account fails before NerdGraph is called.
6. HTTP rejects a missing/invalid bearer, unexpected Host, and unexpected Origin.

Official client references are linked from [source-matrix.md](source-matrix.md#client-and-protocol-sources).
