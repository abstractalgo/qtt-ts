import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { expected } from './expected.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixturesDir = join(root, 'fixtures');
const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.ts'));
const oxlint = join(root, '../../node_modules/.bin/oxlint');

interface OxlintDiagnostic {
  code: string;
  filename: string;
  labels: { span: { line: number } }[];
}

describe('oxlint plugin', () => {
  let diagnostics: OxlintDiagnostic[] = [];

  beforeAll(() => {
    const run = spawnSync(
      oxlint,
      ['-c', 'test/oxlintrc.json', '--format', 'json', 'fixtures'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    );
    diagnostics = (
      JSON.parse(run.stdout) as { diagnostics: OxlintDiagnostic[] }
    ).diagnostics;
  });

  it.each(fixtures)('%s', (name) => {
    const actual = diagnostics
      .filter((d) => join(root, d.filename) === join(fixturesDir, name))
      .map(
        (d) =>
          `${d.labels[0]?.span.line} ${d.code.replace(/^linear-check\((.*)\)$/, '$1')}`,
      )
      .toSorted();
    expect(actual).toEqual(expected(join(fixturesDir, name)));
  });
});
