import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, SERVER_VERSION } from '../../src/version.js';

type ServerConfig = {
  readonly type?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
};

function example(path: string): string {
  return readFileSync(join(process.cwd(), 'examples', path), 'utf8');
}

function jsonServer(path: string): ServerConfig {
  const parsed = JSON.parse(example(path)) as {
    readonly mcpServers?: Readonly<Record<string, ServerConfig>>;
  };
  const server = parsed.mcpServers?.newrelic;
  if (server === undefined) throw new Error(`${path} has no newrelic MCP server`);
  return server;
}

describe('client configuration examples', () => {
  it('keeps Claude Code and Claude Desktop on their documented stdio shapes', () => {
    const code = jsonServer('claude-code.mcp.json');
    const desktop = jsonServer('claude-desktop.json');

    expect(code).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(code.args).toEqual(['-y', `${PACKAGE_NAME}@${SERVER_VERSION}`]);
    expect(code.env?.NEW_RELIC_API_KEY).toBe('${NEW_RELIC_API_KEY}');
    expect(desktop).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(desktop.args).toEqual(code.args);
  });

  it('keeps Cursor environment expansion and Streamable HTTP examples client-specific', () => {
    const cursor = jsonServer('cursor.mcp.json');
    const remote = jsonServer('http.mcp.json');

    expect(cursor.command).toBe('npx');
    expect(cursor.env?.NEW_RELIC_API_KEY).toBe('${env:NEW_RELIC_API_KEY}');
    expect(remote).toMatchObject({ url: 'https://newrelic-mcp.example.com/mcp' });
    expect(remote.type).toBeUndefined();
    expect(remote.headers?.Authorization).toMatch(/^Bearer /u);
  });

  it('keeps the Codex TOML example on supported MCP keys and prompt approvals', () => {
    const codex = example('codex.config.toml');

    expect(codex).toContain('[mcp_servers.newrelic]');
    expect(codex).toContain('[mcp_servers.newrelic.env]');
    expect(codex).toContain('command = "npx"');
    expect(codex).toContain('env_vars = ["NEW_RELIC_API_KEY", "NEW_RELIC_ACCOUNT_ALLOWLIST"]');
    expect(codex).toContain('default_tools_approval_mode = "prompt"');
    expect(codex).not.toMatch(/^auth\s*=/mu);
  });
});
