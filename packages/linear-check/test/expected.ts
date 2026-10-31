import { readFileSync } from 'node:fs';

/** The `line code` pairs a fixture expects, from its trailing `// error: <code>` comments. */
export function expected(file: string): string[] {
  const pairs: string[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      const match = /\/\/ error: ([\w\s,-]+)$/.exec(text);
      for (const code of match?.[1]?.split(',') ?? []) {
        pairs.push(`${i + 1} ${code.trim()}`);
      }
    });
  return pairs.toSorted();
}
