import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { serverFS } from 'typescript/fs';
import { API } from 'typescript/sync';
import type { ParsedCommandLine } from 'typescript/sync';

import { checkProgram } from './check.ts';
import type { QttCode, QttDiagnostic } from './check.ts';

// Runs the type-aware analysis inside oxlint, so its diagnostics reach the editor through
// the oxc extension's language server. Each oxlint process keeps one TypeScript API
// process alive and rebuilds the program for every linted file; the file's text comes
// from oxlint, so unsaved edits are checked. Other files are read from disk.

// oxlint 1.85 doesn't export its plugin types, so this declares the subset the rules use.
interface RuleContext {
  readonly filename: string;
  readonly sourceCode: { readonly ast: object; readonly text: string };
  report(diagnostic: {
    loc: {
      start: { line: number; column: number };
      end: { line: number; column: number };
    };
    message: string;
  }): void;
}

interface Rule {
  meta: { type: 'problem'; docs: { description: string } };
  create(context: RuleContext): { Program(): void };
}

// The text oxlint is linting, served in place of the file on disk.
const overlay = new Map<string, string>();
let api: API | undefined;
const configs = new Map<string, ParsedCommandLine>();

function getApi(): API {
  if (!api) {
    api = new API({
      fs: {
        directoryExists: serverFS.useOS,
        fileExists: serverFS.useOS,
        getAccessibleEntries: serverFS.useOS,
        realpath: serverFS.useOS,
        stat: serverFS.useOS,
        writeFile: serverFS.noop,
        removeFile: serverFS.noop,
        readFile: (fileName) => overlay.get(fileName) ?? serverFS.useOS,
      },
    });
    process.once('exit', () => api?.close());
  }
  return api;
}

function nearestTsconfig(fileName: string): string | undefined {
  let dir = dirname(fileName);
  while (true) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

function check(fileName: string, text: string): QttDiagnostic[] {
  const tsconfig = nearestTsconfig(fileName);
  if (!tsconfig) {
    return [];
  }
  const ts = getApi();
  let config = configs.get(tsconfig);
  if (!config) {
    config = ts.parseConfigFile(tsconfig);
    configs.set(tsconfig, config);
  }
  const known: readonly string[] = config.fileNames;
  const roots = known.includes(fileName) ? known : [...known, fileName];
  overlay.clear();
  overlay.set(fileName, text);
  using program = ts.createProgram(roots, config.options);
  return checkProgram(ts, program, [fileName]);
}

// Every rule asks for the same file's diagnostics; the analysis runs once per AST.
const cache = new WeakMap<object, QttDiagnostic[]>();
let warned = false;

function diagnostics(context: RuleContext): QttDiagnostic[] {
  const { ast, text } = context.sourceCode;
  let result = cache.get(ast);
  if (!result) {
    try {
      result = check(context.filename, text);
    } catch (error) {
      // The beta API process can crash; start a fresh one for the next file.
      api = undefined;
      configs.clear();
      if (!warned) {
        warned = true;
        process.stderr.write(
          `qtt-check: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      result = [];
    }
    cache.set(ast, result);
  }
  return result;
}

function rule(code: QttCode, description: string): Rule {
  return {
    meta: { type: 'problem', docs: { description } },
    create(context) {
      return {
        Program() {
          for (const d of diagnostics(context)) {
            if (d.code === code) {
              context.report({
                // ESLint locations have 1-based lines and 0-based columns.
                loc: {
                  start: { line: d.line, column: d.column - 1 },
                  end: { line: d.endLine, column: d.endColumn - 1 },
                },
                message: d.message,
              });
            }
          }
        },
      };
    },
  };
}

const plugin = {
  meta: { name: 'qtt-check', version: '0.0.0' },
  rules: {
    'use-after-move': rule(
      'use-after-move',
      'Disallow using a linear value after it has been moved.',
    ),
    'not-consumed': rule(
      'not-consumed',
      'Require every linear value to be consumed before it goes out of scope.',
    ),
    captured: rule(
      'captured',
      'Disallow capturing a linear value in a nested function.',
    ),
    overwritten: rule(
      'overwritten',
      'Disallow overwriting a linear binding that may still hold a value.',
    ),
    discarded: rule(
      'discarded',
      'Disallow discarding a freshly produced linear value.',
    ),
    'move-out-of-index': rule(
      'move-out-of-index',
      'Disallow moving a linear element out of a container by a computed index or out of an array.',
    ),
    'moved-borrow': rule(
      'moved-borrow',
      'Disallow moving a borrowed (`Borrow<…>`) parameter.',
    ),
  },
};

export default plugin;
