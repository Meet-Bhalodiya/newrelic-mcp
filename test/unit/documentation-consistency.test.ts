import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ALL_TOOL_NAMES } from '../../src/toolsets/index.js';

function document(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

function escaped(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

describe('public documentation consistency', () => {
  it('maps every public tool exactly once in the official-source matrix', () => {
    const matrix = document('docs/source-matrix.md');

    for (const name of ALL_TOOL_NAMES) {
      const occurrences = matrix.match(new RegExp(`\`${escaped(name)}\``, 'gu')) ?? [];
      expect(occurrences, name).toHaveLength(1);
    }
  });

  it('includes every public tool in the complete tool catalog', () => {
    const catalog = document('docs/tool-catalog.md');

    for (const name of ALL_TOOL_NAMES) {
      expect(catalog, name).toContain(`\`${name}\``);
    }
  });
});
