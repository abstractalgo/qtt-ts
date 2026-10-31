import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { checkProject } from '../src/check.ts';
import type { QttDiagnostic } from '../src/check.ts';
import { expected } from './expected.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.ts'));

describe('fixtures', () => {
  let diagnostics: QttDiagnostic[] = [];

  beforeAll(() => {
    diagnostics = checkProject({
      cwd: root,
      project: 'tsconfig.json',
    }).diagnostics;
  });

  it.each(fixtures)('%s', (name) => {
    const file = join(fixturesDir, name);
    const actual = diagnostics
      .filter((d) => d.file === file)
      .map((d) => `${d.line} ${d.code}`)
      .toSorted();
    expect(actual).toEqual(expected(file));
  });
});
