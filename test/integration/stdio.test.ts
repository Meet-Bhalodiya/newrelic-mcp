import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

describe('stdio transport', () => {
  it('exercises tools, resources, templates, and prompts without contaminating stdout', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', resolve('test/fixtures/stdio-server.ts')],
      env: {
        NEW_RELIC_API_KEY: 'NRAK-test-only',
        NEW_RELIC_DEFAULT_ACCOUNT_ID: '42',
        LOG_LEVEL: 'silent',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(39);
      expect((await client.listResources()).resources).toHaveLength(2);
      expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(6);
      expect((await client.listPrompts()).prompts).toHaveLength(6);

      const capabilities = await client.readResource({
        uri: 'newrelic://server/capabilities',
      });
      const capabilityContent = capabilities.contents[0];
      expect(capabilityContent?.mimeType).toBe('application/json');
      if (capabilityContent === undefined || !('text' in capabilityContent)) {
        throw new TypeError('Expected a text capabilities resource');
      }
      expect(capabilityContent.text).toContain('connection_check');

      const entity = await client.readResource({ uri: 'newrelic://entities/ENTITY' });
      const entityContent = entity.contents[0];
      if (entityContent === undefined || !('text' in entityContent)) {
        throw new TypeError('Expected a text entity resource');
      }
      expect(entityContent.text).toContain('Stdio service');

      const prompt = await client.getPrompt({
        name: 'service_health',
        arguments: { entityGuid: 'ENTITY', accountId: '42' },
      });
      expect(prompt.messages).toHaveLength(1);
      expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });

      const result = await client.callTool({ name: 'connection_check', arguments: {} });
      const structured = result.structuredContent as
        | {
            ok?: unknown;
            data?: unknown;
            meta?: { partial?: unknown; truncated?: unknown };
          }
        | undefined;
      expect(structured).toMatchObject({
        ok: true,
        data: { actor: { user: { id: 'stdio-user' } } },
        meta: { partial: false, truncated: false },
      });
      if (!Array.isArray(result.content)) throw new TypeError('Expected tool content blocks');
      const textContent = result.content[0] as { type?: unknown; text?: unknown } | undefined;
      if (textContent?.type !== 'text' || typeof textContent.text !== 'string') {
        throw new TypeError('Expected text tool content');
      }
      expect(textContent.text).toBe(JSON.stringify(structured));
    } finally {
      await client.close();
    }
  }, 20_000);
});
