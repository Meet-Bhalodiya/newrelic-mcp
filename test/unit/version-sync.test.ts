import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PACKAGE_NAME, SERVER_VERSION } from '../../src/version.js';

type JsonObject = Record<string, unknown>;

function json(path: string): JsonObject {
  return JSON.parse(readFileSync(join(process.cwd(), path), 'utf8')) as JsonObject;
}

function text(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function filesRecursively(path: string): string[] {
  return readdirSync(join(process.cwd(), path), { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesRecursively(child) : [child];
  });
}

describe('release version synchronization', () => {
  it('keeps package, MCP registry, MCPB, and Helm metadata on one version', () => {
    const packageManifest = json('package.json');
    const registryManifest = json('server.json');
    const mcpbManifest = json('mcpb.json');
    const registryPackage = (registryManifest.packages as JsonObject[])[0];
    if (registryPackage === undefined) throw new Error('server.json has no package entry');
    const runtimeArguments = registryPackage.runtimeArguments as JsonObject[];
    const runtimePackage = runtimeArguments.find(
      (argument) =>
        typeof argument.value === 'string' && argument.value.startsWith(`${PACKAGE_NAME}@`),
    );
    const chart = text('helm/newrelic-mcp/Chart.yaml');

    expect(packageManifest.version).toBe(SERVER_VERSION);
    expect(registryManifest.version).toBe(SERVER_VERSION);
    expect(registryPackage.version).toBe(SERVER_VERSION);
    expect(runtimePackage?.value).toBe(`${PACKAGE_NAME}@${SERVER_VERSION}`);
    expect(mcpbManifest.version).toBe(SERVER_VERSION);
    expect(chart).toMatch(new RegExp(`^version: ${SERVER_VERSION.replaceAll('.', '\\.')}$`, 'mu'));
    expect(chart).toMatch(
      new RegExp(`^appVersion: '${SERVER_VERSION.replaceAll('.', '\\.')}'$`, 'mu'),
    );
  });

  it('does not leave stale pinned package or example image versions in documentation', () => {
    const releaseFiles = [
      'README.md',
      'server.json',
      ...filesRecursively('docs'),
      ...filesRecursively('examples'),
    ];
    const pinnedVersions = releaseFiles.flatMap((path) => [
      ...text(path).matchAll(/@meet-bhalodiya\/newrelic-mcp@(\d+\.\d+\.\d+)/gu),
    ]);

    expect(pinnedVersions.length).toBeGreaterThan(0);
    expect(pinnedVersions.every((match) => match[1] === SERVER_VERSION)).toBe(true);
    expect(text('examples/helm-values.yaml')).toContain(`tag: '${SERVER_VERSION}'`);
  });
});
