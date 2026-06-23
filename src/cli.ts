#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Command, InvalidArgumentError } from 'commander';

import { ConfigurationError, loadConfig, safeConfig } from './config/index.js';
import { runDoctor } from './doctor.js';
import { closeHttpServer, startHttpServer } from './http.js';
import { createRuntime } from './runtime.js';
import { createMcpServer } from './server.js';
import {
  EXCLUDED_CAPABILITIES,
  catalogByToolset,
  enabledToolNames,
  type CapabilityGates,
} from './toolsets/index.js';
import { SERVER_VERSION } from './version.js';

const program = new Command();
program
  .name('newrelic-mcp')
  .description('Production-grade New Relic MCP server')
  .version(SERVER_VERSION)
  .showHelpAfterError();

program
  .command('stdio', { isDefault: true })
  .description('Run the MCP server over stdin/stdout')
  .action(async () => {
    const runtime = createRuntime(loadConfig());
    const server = createMcpServer(runtime);
    const transport = new StdioServerTransport();
    installProcessErrorHandlers(runtime.observability.logger);
    installShutdown(async () => {
      await server.close();
      runtime.observability.logger.flush();
    });
    await server.connect(transport);
  });

program
  .command('http')
  .description('Run stateless Streamable HTTP')
  .option('--host <host>', 'bind host')
  .option('--port <port>', 'bind port', parsePort)
  .action(async (options: { host?: string; port?: number }) => {
    const environment = {
      ...process.env,
      ...(options.host === undefined ? {} : { MCP_HTTP_HOST: options.host }),
      ...(options.port === undefined ? {} : { MCP_HTTP_PORT: String(options.port) }),
    };
    const runtime = createRuntime(loadConfig(environment));
    installProcessErrorHandlers(runtime.observability.logger);
    const httpServer = await startHttpServer(runtime, (requestContext) =>
      createMcpServer(runtime, requestContext),
    );
    runtime.observability.logger.info(
      {
        host: runtime.config.http.host,
        port: runtime.config.http.port,
        authMode: runtime.config.http.auth.mode,
      },
      'New Relic MCP HTTP server listening',
    );
    installShutdown(async () => {
      await closeHttpServer(httpServer);
      runtime.observability.logger.flush();
    });
  });

program
  .command('doctor')
  .description('Validate New Relic connectivity and fixed schema expectations')
  .option('--json', 'print JSON')
  .action(async (options: { json?: boolean }) => {
    const runtime = createRuntime(loadConfig());
    const report = await runDoctor(runtime);
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const check of report.checks) {
        process.stdout.write(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.message}\n`);
      }
    }
    if (!report.ok) process.exitCode = 1;
  });

program
  .command('tools')
  .description('Print enabled toolsets and gates without calling New Relic')
  .option('--json', 'print JSON')
  .action((options: { json?: boolean }) => {
    const config = loadConfig();
    const gates: CapabilityGates = {
      enabledToolsets: config.toolsets,
      ...config.gates,
    };
    const report = {
      config: safeConfig(config),
      enabledTools: enabledToolNames(gates),
      catalog: catalogByToolset(),
      excludedCapabilities: EXCLUDED_CAPABILITIES,
    };
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`Enabled toolsets: ${config.toolsets.join(', ')}\n`);
      process.stdout.write(
        `Enabled tools (${report.enabledTools.length}): ${report.enabledTools.join(', ')}\n`,
      );
      process.stdout.write(`Safety gates: ${JSON.stringify(config.gates)}\n`);
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof ConfigurationError) {
    if (process.argv.includes('doctor') && process.argv.includes('--json')) {
      process.stdout.write(
        `${JSON.stringify(
          {
            ok: false,
            config: null,
            checks: [
              {
                name: 'configuration',
                ok: false,
                message: `Configuration is invalid: ${error.issues.join('; ')}`,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stderr.write(
        `Configuration error:\n${error.issues.map((issue) => `- ${issue}`).join('\n')}\n`,
      );
    }
  } else if (error instanceof Error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
  } else {
    process.stderr.write('Unknown startup error.\n');
  }
  process.exitCode = 1;
}

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value)) throw new InvalidArgumentError('port must be an integer');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new InvalidArgumentError('port must be between 1 and 65535');
  }
  return port;
}

function installShutdown(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function installProcessErrorHandlers(logger: {
  fatal: (bindings: Record<string, unknown>, message: string) => unknown;
  flush: () => void;
}): void {
  process.on('uncaughtException', (error) => {
    logger.fatal({ errorType: error.name }, 'Uncaught process exception');
    logger.flush();
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logger.fatal(
      { errorType: error instanceof Error ? error.name : 'UnknownError' },
      'Unhandled promise rejection',
    );
    logger.flush();
    process.exit(1);
  });
}
