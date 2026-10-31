#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { checkProject } from './check.ts';

const USAGE = 'usage: qtt-check [-p path/to/tsconfig.json] [files...]\n';

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const cwd = process.cwd();
  let project = values.project;
  if (!project && existsSync(resolve(cwd, 'tsconfig.json'))) {
    project = 'tsconfig.json';
  }
  if (!project && positionals.length === 0) {
    process.stderr.write(
      `qtt-check: no tsconfig.json found and no files given\n${USAGE}`,
    );
    return 2;
  }

  const started = performance.now();
  const result = checkProject({ cwd, project, files: positionals });
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);

  const sorted = result.diagnostics.toSorted(
    (a, b) =>
      a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
  );
  let out = '';
  for (const d of sorted) {
    out += `${relative(cwd, d.file)}:${d.line}:${d.column}  ${d.code}  ${d.message}\n`;
  }
  const count = sorted.length;
  out += `${count} ${count === 1 ? 'problem' : 'problems'} in ${result.filesChecked} files (${result.programFiles} in program), ${elapsed}s\n`;
  process.stdout.write(out);
  return count > 0 ? 1 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(
    `qtt-check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 2;
}
