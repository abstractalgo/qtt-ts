import { realpathSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SyntaxKind } from 'typescript/ast';
import type {
  ArrayLiteralExpression,
  BinaryExpression,
  BindingElement,
  BindingName,
  Block,
  BreakStatement,
  CallExpression,
  CaseBlock,
  ClassLikeDeclaration,
  ConditionalExpression,
  ContinueStatement,
  DoStatement,
  ElementAccessExpression,
  ExpressionStatement,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  Identifier,
  IfStatement,
  LabeledStatement,
  NewExpression,
  Node,
  ObjectLiteralExpression,
  ParameterDeclaration,
  PropertyAccessExpression,
  ReturnStatement,
  SourceFile,
  Statement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  VariableDeclaration,
  VariableDeclarationList,
  VariableStatement,
  WhileStatement,
} from 'typescript/ast';
import { isTypeNode } from 'typescript/ast/is';
import {
  API,
  IndexKind,
  ObjectFlags,
  SymbolFlags,
  TypeFlags,
} from 'typescript/sync';
import type {
  Checker,
  Program,
  Signature,
  Symbol as TsSymbol,
  Type,
  TypeReference,
} from 'typescript/sync';

export type LinearCode =
  | 'use-after-move'
  | 'not-consumed'
  | 'captured'
  | 'overwritten'
  | 'discarded'
  | 'move-out-of-index'
  | 'moved-borrow';

export interface LinearDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly code: LinearCode;
  readonly message: string;
}

export interface CheckOptions {
  /** Restrict analysis to these files (absolute or relative to `cwd`). Defaults to every root file. */
  readonly files?: readonly string[];
  readonly cwd?: string;
  /** Path to a tsconfig.json. Without one, `files` are checked with default options. */
  readonly project?: string;
}

export interface CheckResult {
  readonly diagnostics: LinearDiagnostic[];
  readonly filesChecked: number;
  readonly programFiles: number;
}

/** Builds a program from a tsconfig (or loose files) and runs the linear-ownership analysis on it. */
export function checkProject(options: CheckOptions): CheckResult {
  const cwd = options.cwd ?? process.cwd();
  using api = new API({ cwd });
  let rootNames: readonly string[];
  // Raw string option values crash the beta's Go process, so the fallback uses numeric enum values.
  let compilerOptions: Record<string, unknown> = {
    strict: true,
    target: 99,
    module: 199,
    allowImportingTsExtensions: true,
    noEmit: true,
  };
  if (options.project) {
    const parsed = api.parseConfigFile(resolvePath(cwd, options.project));
    rootNames = parsed.fileNames;
    compilerOptions = parsed.options as Record<string, unknown>;
  } else {
    rootNames = (options.files ?? []).map((f) => resolvePath(cwd, f));
  }
  const programRoots = options.project
    ? [
        ...new Set([
          ...rootNames,
          ...(options.files ?? []).map((f) => resolvePath(cwd, f)),
        ]),
      ]
    : rootNames;
  using program = api.createProgram(programRoots, compilerOptions);
  const targets = options.files?.length
    ? options.files.map((f) => resolvePath(cwd, f))
    : rootNames;
  const diagnostics = checkProgram(api, program, targets);
  return {
    diagnostics,
    filesChecked: targets.filter(isAnalysable).length,
    programFiles: program.getSourceFileNames().length,
  };
}

function isAnalysable(fileName: string): boolean {
  return (
    /\.[cm]?tsx?$/.test(fileName) &&
    !/\.d\.[cm]?ts$/.test(fileName) &&
    !fileName.includes('/node_modules/')
  );
}

const OWN_BRAND_FILE = realpathSync(
  fileURLToPath(new URL('./index.ts', import.meta.url)),
);
const PUBLISHED_BRAND_FILE = /\/node_modules\/linear-check\/src\/index\.ts$/;
const PUBLISHED_PACKAGE = /\/node_modules\/linear-check\//;

interface BrandNames {
  readonly linear: Set<string>;
  readonly borrow: Set<string>;
}

/** Returns the escaped property names of this package's `linearBrand` and `borrowBrand`, or none when no file in the program imports them. */
function findBrandNames(
  api: API,
  program: Program,
  checker: Checker,
): BrandNames {
  const names: BrandNames = { linear: new Set(), borrow: new Set() };
  const candidates = program
    .getSourceFileNames()
    .filter((f) => PUBLISHED_BRAND_FILE.test(f) || samePath(f, OWN_BRAND_FILE));
  if (candidates.length === 0) {
    return names;
  }
  const files = api.batch(
    ...candidates.map((f) => program.getSourceFile.gen(f)),
  );
  for (const file of files) {
    if (!file) {
      continue;
    }
    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.PropertySignature) {
        const name = (node as Node & { name: Node }).name;
        if (name.kind === SyntaxKind.ComputedPropertyName) {
          const expr = (name as Node & { expression: Node }).expression;
          const text =
            expr.kind === SyntaxKind.Identifier
              ? (expr as Identifier).text
              : '';
          if (text === 'linearBrand' || text === 'borrowBrand') {
            const set = text === 'linearBrand' ? names.linear : names.borrow;
            set.add(checker.getSymbolOfDeclaration(node as never).escapedName);
          }
        }
      }
      node.forEachChild(visit);
    };
    visit(file);
  }
  return names;
}

function samePath(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  try {
    return realpathSync(a) === b;
  } catch {
    return false;
  }
}

interface TypeInfo {
  readonly kind: 'object' | 'union' | 'instantiable';
  brand: 'linear' | 'borrow' | undefined;
  readonly children: number[];
  /** Non-method property names of an object type, with their types. */
  readonly props: Map<string, number>;
}

/**
 * Decides linearity of types, batching IPC round trips and caching by type id.
 *
 * A type is linear if it carries the linear brand, or if any union member, base constraint,
 * non-method property type or number index type is linear (containers). Types carrying the
 * borrow brand are never linear. The type graph is explored breadth first, one batch per level,
 * and linearity is then propagated backwards from branded types, so recursive types are fine.
 */
class LinearTypes {
  private readonly info = new Map<number, TypeInfo>();
  private readonly linear = new Set<number>();
  private readonly parents = new Map<number, number[]>();
  private readonly borrowCache = new Map<number, boolean>();
  private readonly partsCache = new Map<
    number,
    ReadonlyMap<string, number> | undefined
  >();
  /** Whether a symbol is declared only in lib or `node_modules` files, by symbol id. */
  private readonly external = new Map<number, boolean>();
  /** Instantiations of external generic types whose properties haven't been fetched, with their type arguments. */
  private readonly deferred = new Map<
    number,
    { readonly type: Type; readonly args: readonly number[] }
  >();
  private readonly api: API;
  private readonly checker: Checker;
  private readonly brands: BrandNames;

  constructor(api: API, checker: Checker, brands: BrandNames) {
    this.api = api;
    this.checker = checker;
    this.brands = brands;
  }

  areLinear(types: readonly Type[]): boolean[] {
    let reopen: Type[] = [];
    for (let roots = types; roots.length > 0 || reopen.length > 0; roots = []) {
      this.propagate(this.walk(roots, reopen));
      reopen = [];
      for (const [id, d] of this.deferred) {
        if (d.args.some((a) => this.linear.has(a))) {
          this.deferred.delete(id);
          reopen.push(d.type);
        }
      }
    }
    return types.map((t) => this.linear.has(t.id));
  }

  /** Whether the type carries the borrow brand, directly or through a union member or constraint. Only valid after exploring it. */
  isBorrow(id: number): boolean {
    let result = this.borrowCache.get(id);
    if (result === undefined) {
      this.borrowCache.set(id, false);
      const info = this.info.get(id);
      result =
        info?.brand === 'borrow' ||
        (info !== undefined &&
          info.kind !== 'object' &&
          info.children.some((c) => this.isBorrow(c)));
      this.borrowCache.set(id, result);
    }
    return result;
  }

  /** The linear fixed parts (property names or tuple indices) of a container type, with their types. */
  partsOf(id: number | undefined): ReadonlyMap<string, number> | undefined {
    if (id === undefined) {
      return undefined;
    }
    if (this.partsCache.has(id)) {
      return this.partsCache.get(id);
    }
    this.partsCache.set(id, undefined);
    const info = this.info.get(id);
    let parts: ReadonlyMap<string, number> | undefined;
    if (info?.kind === 'object') {
      const linearProps = [...info.props].filter(([, t]) => this.linear.has(t));
      parts = linearProps.length > 0 ? new Map(linearProps) : undefined;
    } else if (info) {
      // For `Pair | undefined` and the like, the parts are those of the one linear member.
      const linearChildren = info.children.filter((c) => this.linear.has(c));
      parts =
        linearChildren.length === 1
          ? this.partsOf(linearChildren[0])
          : undefined;
    }
    this.partsCache.set(id, parts);
    return parts;
  }

  /**
   * Splits object types by whether their properties need fetching. Types declared only in lib or
   * `node_modules` files can't mention this package's brand, so a non-generic one is never
   * linear, and a generic instantiation (`Array<Token>`, `ZodObject<…>`) can only be linear
   * through its type arguments. This keeps the DOM, React and schema-library type graphs out.
   */
  private splitExternal(objects: readonly Type[]): {
    full: Type[];
    generic: Type[];
  } {
    const declared = (t: Type): boolean =>
      (objectFlagsOf(t) & ObjectFlags.ClassOrInterface) !== 0;
    const instance = (t: Type): boolean =>
      (objectFlagsOf(t) & ObjectFlags.Reference) !== 0 &&
      (t as Type & { target?: number }).target !== t.id;
    const candidates = objects.filter((t) => declared(t) || instance(t));
    const externalTypes = new Set<number>();
    for (const chunk of chunks(candidates)) {
      this.api
        .batch(...chunk.map((t) => (t as Type & TypeSymbol).getSymbol.gen()))
        .forEach((sym, i) => {
          if (!sym) {
            return;
          }
          let ext = this.external.get(sym.id);
          if (ext === undefined) {
            const paths = sym.declarations?.map((d) => d.path) ?? [];
            ext =
              paths.length > 0 &&
              paths.every(
                (p) =>
                  p.includes('/node_modules/') && !PUBLISHED_PACKAGE.test(p),
              );
            this.external.set(sym.id, ext);
          }
          if (ext) {
            externalTypes.add((chunk[i] as Type).id);
          }
        });
    }
    return {
      full: objects.filter((t) => !externalTypes.has(t.id)),
      generic: objects.filter((t) => externalTypes.has(t.id) && instance(t)),
    };
  }

  /** Explores the types reachable from `roots`, plus the properties of reopened deferred types. Returns the ids to propagate from. */
  private walk(roots: readonly Type[], reopen: readonly Type[]): number[] {
    const added: number[] = reopen.map((t) => t.id);
    const fresh = new Map<number, Type>();
    for (const t of roots) {
      if (!this.info.has(t.id)) {
        fresh.set(t.id, t);
      }
    }
    let frontier = [...fresh.values()];
    let reopened = [...reopen];
    // Types reached only through properties or index signatures, rather than as a requested type or its union members.
    let nested = new Set<number>();
    while (frontier.length > 0 || reopened.length > 0) {
      const next: Type[] = [];
      const queued = new Set<number>();
      const nextNested = new Set<number>();
      const enqueue = (
        parent: number,
        child: Type,
        viaProperty: boolean,
      ): void => {
        if (viaProperty || nested.has(parent)) {
          if (!queued.has(child.id)) {
            nextNested.add(child.id);
          }
        } else {
          nextNested.delete(child.id);
        }
        if (!this.info.has(child.id) && !queued.has(child.id)) {
          queued.add(child.id);
          next.push(child);
        }
      };
      const link = (
        parent: number,
        child: Type | undefined,
        viaProperty = false,
      ): void => {
        if (!child) {
          return;
        }
        (this.info.get(parent) as TypeInfo).children.push(child.id);
        const ps = this.parents.get(child.id);
        if (ps) {
          ps.push(parent);
        } else {
          this.parents.set(child.id, [parent]);
        }
        enqueue(parent, child, viaProperty);
      };
      const objects: Type[] = [];
      const unions: Type[] = [];
      const instantiable: Type[] = [];
      for (const type of frontier) {
        let kind: TypeInfo['kind'] | undefined;
        if (type.flags & TypeFlags.Union) {
          kind = 'union';
          unions.push(type);
        } else if (type.flags & (TypeFlags.Object | TypeFlags.Intersection)) {
          kind = 'object';
          objects.push(type);
        } else if (type.flags & TypeFlags.InstantiableNonPrimitive) {
          // Generic types inside containers are left opaque: following the constraints of
          // conditional and indexed access types in library generics (form libraries' deep
          // mapped types, for example) can produce an unbounded stream of new types.
          if (nested.has(type.id)) {
            continue;
          }
          kind = 'instantiable';
          instantiable.push(type);
        }
        this.info.set(type.id, {
          kind: kind ?? 'object',
          brand: undefined,
          children: [],
          props: new Map(),
        });
        added.push(type.id);
      }

      const { full, generic } = this.splitExternal(objects);
      for (const chunk of chunks(generic)) {
        const args = this.api.batch(
          ...chunk.map((t) =>
            this.checker.getTypeArguments.gen(t as TypeReference),
          ),
        );
        chunk.forEach((t, i) => {
          const list = args[i] ?? [];
          this.deferred.set(t.id, { type: t, args: list.map((a) => a.id) });
          for (const a of list) {
            enqueue(t.id, a, false);
          }
        });
      }
      for (const chunk of chunks([...full, ...reopened])) {
        const results = this.api.batch(
          ...chunk.flatMap((t) => [
            this.checker.getPropertiesOfType.gen(t),
            this.checker.getIndexTypeOfType.gen(t, IndexKind.Number),
          ]),
        ) as unknown[];
        const symbols: TsSymbol[] = [];
        const owners: number[] = [];
        chunk.forEach((t, i) => {
          const info = this.info.get(t.id) as TypeInfo;
          const props =
            (results[2 * i] as readonly TsSymbol[] | undefined) ?? [];
          for (const p of props) {
            if (this.brands.borrow.has(p.escapedName)) {
              info.brand = 'borrow';
            } else if (
              this.brands.linear.has(p.escapedName) &&
              info.brand === undefined
            ) {
              info.brand = 'linear';
            } else if (!(p.flags & SymbolFlags.Method)) {
              symbols.push(p);
              owners.push(t.id);
            }
          }
          link(t.id, results[2 * i + 1] as Type | undefined, true);
        });
        for (let start = 0; start < symbols.length; start += CHUNK) {
          const slice = symbols.slice(start, start + CHUNK);
          const propTypes = this.api.batch(
            this.checker.getTypeOfSymbol.gen(slice),
          )[0];
          slice.forEach((p, i) => {
            const owner = owners[start + i] as number;
            const propType = propTypes[i];
            if (propType) {
              (this.info.get(owner) as TypeInfo).props.set(p.name, propType.id);
              link(owner, propType, true);
            }
          });
        }
      }
      for (const chunk of chunks(unions)) {
        const members = this.api.batch(
          ...chunk.map((t) => (t as Type & UnionMembers).getTypes.gen()),
        );
        chunk.forEach((t, i) => {
          for (const m of members[i] ?? []) {
            link(t.id, m);
          }
        });
      }
      for (const chunk of chunks(instantiable)) {
        const constraints = this.api.batch(
          ...chunk.map((t) => this.checker.getBaseConstraintOfType.gen(t)),
        );
        chunk.forEach((t, i) => link(t.id, constraints[i]));
      }
      frontier = next;
      reopened = [];
      nested = nextNested;
    }
    return added;
  }

  private propagate(ids: readonly number[]): void {
    const work: number[] = [];
    const mark = (id: number): void => {
      if (!this.linear.has(id) && this.info.get(id)?.brand !== 'borrow') {
        this.linear.add(id);
        work.push(id);
      }
    };
    for (const id of ids) {
      const info = this.info.get(id) as TypeInfo;
      if (
        info.brand === 'linear' ||
        info.children.some((c) => this.linear.has(c))
      ) {
        mark(id);
      }
    }
    for (let id = work.pop(); id !== undefined; id = work.pop()) {
      for (const p of this.parents.get(id) ?? []) {
        mark(p);
      }
    }
  }
}

function objectFlagsOf(t: Type): number {
  return (t as Type & { objectFlags?: number }).objectFlags ?? 0;
}

interface TypeSymbol {
  getSymbol: { gen(): Generator<never, TsSymbol | undefined, unknown> };
}

interface UnionMembers {
  getTypes: { gen(): Generator<never, readonly Type[], unknown> };
}

const CHUNK = 4000;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
}

/** Facts gathered up front for all files, so the checker is queried in a few batches instead of per node. */
interface Facts {
  /** Declaration name identifiers whose binding is linear. */
  readonly linearNames: Set<Node>;
  /** Parameter name identifiers typed `Borrow<…>`. */
  readonly borrowNames: Set<Node>;
  /** Type ids of linear and borrowed bindings, by declaration name, for finding their linear parts. */
  readonly bindingTypes: Map<Node, number>;
  /** Initializers and assignment right-hand sides of linear bindings whose value is not linear (e.g. `undefined`). */
  readonly nonLinearValues: Set<Node>;
  /** Expression statements that produce a linear value. */
  readonly discarded: Set<Node>;
  /** Element accesses on tracked bindings whose value is linear. */
  readonly linearElements: Set<Node>;
  /** Call arguments passed to a `Borrow<…>` parameter. */
  readonly borrowArgs: Set<Node>;
  /** Method calls on tracked receivers whose signature declares a linear `this`. */
  readonly consumingCalls: Set<Node>;
  readonly typesFor: LinearTypes;
}

export function checkProgram(
  api: API,
  program: Program,
  fileNames: readonly string[],
): LinearDiagnostic[] {
  const checker = program.getProject().checker;
  const brands = findBrandNames(api, program, checker);
  // Nothing in the program can be linear if the brand isn't part of it.
  if (brands.linear.size === 0) {
    return [];
  }
  const names = fileNames.filter(isAnalysable);
  const files = api
    .batch(...names.map((f) => program.getSourceFile.gen(f)))
    .filter((f): f is SourceFile => f !== undefined);
  const typesFor = new LinearTypes(api, checker, brands);

  const found: Collected = {
    bindingNames: [],
    statements: [],
    calls: [],
    elements: [],
  };
  for (const file of files) {
    collect(file, found);
  }
  const { bindingNames, statements } = found;
  const linearNames = new Set<Node>();
  const borrowNames = new Set<Node>();
  const bindingTypes = new Map<Node, number>();
  const nameTypes = batchTypes(api, checker, bindingNames);
  typesFor.areLinear(nameTypes).forEach((linear, i) => {
    const name = bindingNames[i] as Node;
    const type = nameTypes[i] as Type;
    if (linear) {
      linearNames.add(name);
      bindingTypes.set(name, type.id);
    } else if (
      name.parent.kind === SyntaxKind.Parameter &&
      typesFor.isBorrow(type.id)
    ) {
      borrowNames.add(name);
      bindingTypes.set(name, type.id);
    }
  });

  const linearTexts = new Set(
    [...linearNames].map((n) => (n as Identifier).text),
  );
  const trackedTexts = new Set([
    ...linearTexts,
    ...[...borrowNames].map((n) => (n as Identifier).text),
  ]);
  const values: Node[] = [];
  for (const name of linearNames) {
    const decl = name.parent;
    if (
      decl.kind === SyntaxKind.VariableDeclaration &&
      (decl as VariableDeclaration).initializer
    ) {
      values.push((decl as VariableDeclaration).initializer as Node);
    }
  }
  for (const file of files) {
    collectAssignedValues(file, linearTexts, values);
  }
  const nonLinearValues = new Set<Node>();
  typesFor.areLinear(batchTypes(api, checker, values)).forEach((linear, i) => {
    if (!linear) {
      nonLinearValues.add(values[i] as Node);
    }
  });

  const discarded = new Set<Node>();
  const stmtTypes = batchTypes(
    api,
    checker,
    statements.map((s) => (s as ExpressionStatement).expression),
  );
  typesFor.areLinear(stmtTypes).forEach((linear, i) => {
    if (linear) {
      discarded.add(statements[i] as Node);
    }
  });

  const tracked = (node: Node): boolean => {
    const root = chainRoot(node);
    return root !== undefined && trackedTexts.has(root.text);
  };

  const linearElements = new Set<Node>();
  const elements = found.elements.filter(tracked);
  typesFor
    .areLinear(batchTypes(api, checker, elements))
    .forEach((linear, i) => {
      if (linear) {
        linearElements.add(elements[i] as Node);
      }
    });

  const { borrowArgs, consumingCalls } = analyzeCalls(
    api,
    checker,
    typesFor,
    found.calls,
    tracked,
  );

  const facts: Facts = {
    linearNames,
    borrowNames,
    bindingTypes,
    nonLinearValues,
    discarded,
    linearElements,
    borrowArgs,
    consumingCalls,
    typesFor,
  };
  const diagnostics: LinearDiagnostic[] = [];
  for (const file of files) {
    diagnostics.push(...analyzeFile(file, facts));
  }
  return diagnostics;
}

type CallLike = CallExpression | NewExpression;

/** Resolves the signatures of calls that involve tracked bindings, to find borrowed arguments and consuming methods. */
function analyzeCalls(
  api: API,
  checker: Checker,
  typesFor: LinearTypes,
  allCalls: readonly CallLike[],
  tracked: (node: Node) => boolean,
): { borrowArgs: Set<Node>; consumingCalls: Set<Node> } {
  const borrowArgs = new Set<Node>();
  const consumingCalls = new Set<Node>();
  const receiverOf = (call: CallLike): Node | undefined => {
    const callee = skipParens(call.expression);
    return call.kind === SyntaxKind.CallExpression &&
      (callee.kind === SyntaxKind.PropertyAccessExpression ||
        callee.kind === SyntaxKind.ElementAccessExpression)
      ? (callee as PropertyAccessExpression).expression
      : undefined;
  };
  const calls = allCalls.filter((call) => {
    const receiver = receiverOf(call);
    return (
      (receiver !== undefined && tracked(receiver)) ||
      (call.arguments ?? []).some(tracked)
    );
  });
  const signatures: Signature[] = [];
  for (const chunk of chunks(calls)) {
    signatures.push(
      ...api.batch(...chunk.map((c) => checker.getResolvedSignature.gen(c))),
    );
  }
  const unknown: boolean[] = [];
  for (const chunk of chunks(signatures)) {
    unknown.push(
      ...api.batch(...chunk.map((sig) => checker.isUnknownSignature.gen(sig))),
    );
  }

  const receivers: { call: CallLike; sig: Signature }[] = [];
  const params: { arg: Node; sig: Signature; index: number }[] = [];
  calls.forEach((call, i) => {
    const sig = signatures[i];
    if (!sig || unknown[i]) {
      return;
    }
    const receiver = receiverOf(call);
    if (receiver !== undefined && tracked(receiver)) {
      receivers.push({ call, sig });
    }
    (call.arguments ?? []).forEach((arg, index) => {
      if (arg.kind !== SyntaxKind.SpreadElement && tracked(arg)) {
        params.push({ arg, sig, index });
      }
    });
  });

  const thisCalls: CallLike[] = [];
  const thisParams: TsSymbol[] = [];
  for (const chunk of chunks(receivers)) {
    api
      .batch(...chunk.map((r) => r.sig.getThisParameter.gen()))
      .forEach((p, i) => {
        if (p) {
          thisCalls.push((chunk[i] as { call: CallLike }).call);
          thisParams.push(p);
        }
      });
  }
  const thisTypes: Type[] = [];
  for (const chunk of chunks(thisParams)) {
    thisTypes.push(...api.batch(checker.getTypeOfSymbol.gen(chunk))[0]);
  }
  typesFor.areLinear(thisTypes).forEach((linear, i) => {
    if (linear) {
      consumingCalls.add(thisCalls[i] as Node);
    }
  });

  const paramTypes: Type[] = [];
  for (const chunk of chunks(params)) {
    paramTypes.push(
      ...api.batch(
        ...chunk.map((p) => checker.getParameterType.gen(p.sig, p.index)),
      ),
    );
  }
  typesFor.areLinear(paramTypes);
  paramTypes.forEach((type, i) => {
    if (typesFor.isBorrow(type.id)) {
      borrowArgs.add((params[i] as { arg: Node }).arg);
    }
  });
  return { borrowArgs, consumingCalls };
}

function batchTypes(
  api: API,
  checker: Checker,
  nodes: readonly Node[],
): Type[] {
  const out: Type[] = [];
  for (const chunk of chunks(nodes)) {
    out.push(...api.batch(checker.getTypeAtLocation.gen(chunk))[0]);
  }
  return out;
}

/** The identifier at the root of a property or element access chain (`pair` in `pair[0].id`), if any. */
function chainRoot(node: Node): Identifier | undefined {
  let n = skipParens(node);
  while (
    n.kind === SyntaxKind.PropertyAccessExpression ||
    n.kind === SyntaxKind.ElementAccessExpression
  ) {
    n = skipParens((n as PropertyAccessExpression).expression);
  }
  return n.kind === SyntaxKind.Identifier ? (n as Identifier) : undefined;
}

interface Collected {
  readonly bindingNames: Identifier[];
  readonly statements: Node[];
  readonly calls: CallLike[];
  readonly elements: Node[];
}

function collect(file: SourceFile, out: Collected): void {
  const addBindingNames = (name: BindingName): void => {
    if (name.kind === SyntaxKind.Identifier) {
      out.bindingNames.push(name);
      return;
    }
    for (const element of (name as Node & { elements: readonly Node[] })
      .elements) {
      if (
        element.kind === SyntaxKind.BindingElement &&
        (element as BindingElement).name
      ) {
        addBindingNames((element as BindingElement).name as BindingName);
      }
    }
  };
  const visit = (node: Node): void => {
    if (isTypeNode(node)) {
      return;
    }
    switch (node.kind) {
      case SyntaxKind.InterfaceDeclaration:
      case SyntaxKind.TypeAliasDeclaration:
        return;
      case SyntaxKind.VariableDeclaration:
        if (node.parent.kind !== SyntaxKind.CatchClause) {
          addBindingNames((node as VariableDeclaration).name);
        }
        break;
      case SyntaxKind.Parameter: {
        const name = (node as ParameterDeclaration).name;
        if (
          !(name.kind === SyntaxKind.Identifier && name.text === 'this') &&
          hasBody(node.parent)
        ) {
          addBindingNames(name);
        }
        break;
      }
      case SyntaxKind.ExpressionStatement:
        if (mayProduceValue((node as ExpressionStatement).expression)) {
          out.statements.push(node);
        }
        break;
      case SyntaxKind.CallExpression:
        // Dynamic `import()` isn't a signature call; resolving it would be wasted at best.
        if (
          (node as CallExpression).expression.kind !== SyntaxKind.ImportKeyword
        ) {
          out.calls.push(node as CallExpression);
        }
        break;
      case SyntaxKind.NewExpression:
        out.calls.push(node as NewExpression);
        break;
      case SyntaxKind.ElementAccessExpression:
        out.elements.push(node);
        break;
    }
    node.forEachChild(visit);
  };
  visit(file);
}

function hasBody(fn: Node): boolean {
  return (fn as Node & { body?: Node }).body !== undefined;
}

function mayProduceValue(expr: Node): boolean {
  const e = skipParens(expr);
  switch (e.kind) {
    case SyntaxKind.VoidExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
      return false;
    case SyntaxKind.BinaryExpression:
      return !isAssignmentOperator((e as BinaryExpression).operatorToken.kind);
    default:
      return true;
  }
}

function collectAssignedValues(
  file: SourceFile,
  linearTexts: Set<string>,
  out: Node[],
): void {
  const visit = (node: Node): void => {
    if (node.kind === SyntaxKind.BinaryExpression) {
      const bin = node as BinaryExpression;
      const left = skipParens(bin.left);
      if (
        bin.operatorToken.kind === SyntaxKind.EqualsToken &&
        left.kind === SyntaxKind.Identifier &&
        linearTexts.has((left as Identifier).text)
      ) {
        out.push(bin.right);
      }
    }
    node.forEachChild(visit);
  };
  if (linearTexts.size > 0) {
    visit(file);
  }
}

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return (
    kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment
  );
}

function skipParens(node: Node): Node {
  let n = node;
  while (
    n.kind === SyntaxKind.ParenthesizedExpression ||
    n.kind === SyntaxKind.NonNullExpression ||
    n.kind === SyntaxKind.AsExpression ||
    n.kind === SyntaxKind.SatisfiesExpression ||
    n.kind === SyntaxKind.TypeAssertionExpression
  ) {
    n = (n as Node & { expression: Node }).expression;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Dataflow
// ---------------------------------------------------------------------------

const OWNED = 0;
const MAYBE = 1;
const MOVED = 2;
type Ownership = typeof OWNED | typeof MAYBE | typeof MOVED;
/**
 * Ownership per place. A binding is present while it's in scope. Places under it (`pair[0]`,
 * `held.first`) are present only once they've been moved or joined; an absent one has its
 * nearest present ancestor's state.
 */
type State = Map<Place, Ownership>;
/** `borrow` reads the whole place; `read` reads through it to a non-linear part, so moved siblings don't matter. */
type Use = 'move' | 'borrow' | 'read';

/** A binding, or a binding followed by fixed property names or tuple indices. */
interface Place {
  readonly parent: Place | undefined;
  readonly label: string;
  /** Type id, for finding the linear parts. */
  readonly type: number | undefined;
  readonly children: Map<string, Place>;
}

interface Binding extends Place {
  readonly name: string;
  readonly decl: Node;
  readonly linear: boolean;
  readonly borrow: boolean;
}

function rootOf(p: Place): Binding {
  let q = p;
  while (q.parent) {
    q = q.parent;
  }
  return q as Binding;
}

function isWithin(p: Place, ancestor: Place): boolean {
  for (let q: Place | undefined = p; q; q = q.parent) {
    if (q === ancestor) {
      return true;
    }
  }
  return false;
}

function childPlace(p: Place, key: string, type: number): Place {
  let c = p.children.get(key);
  if (!c) {
    const label = /^\d+$/.test(key)
      ? `${p.label}[${key}]`
      : /^[A-Za-z_$][\w$]*$/.test(key)
        ? `${p.label}.${key}`
        : `${p.label}[${JSON.stringify(key)}]`;
    c = { parent: p, label, type, children: new Map() };
    p.children.set(key, c);
  }
  return c;
}

/** A place's state, taking moves of the places containing it into account. */
function effective(s: State, p: Place): Ownership {
  let v: Ownership = OWNED;
  for (let q: Place | undefined = p; q; q = q.parent) {
    const e = s.get(q);
    if (e !== undefined && e > v) {
      v = e;
    }
  }
  return v;
}

function deleteWithin(s: State, p: Place): void {
  for (const q of s.keys()) {
    if (q !== p && isWithin(q, p)) {
      s.delete(q);
    }
  }
}

interface Scope {
  readonly names: Map<string, Binding>;
  readonly linear: Binding[];
}

interface BreakFrame {
  readonly kind: 'break';
  readonly labels: readonly string[];
  readonly loop: boolean;
  readonly depth: number;
  readonly continueDepth: number;
  readonly breaks: State[];
  readonly continues: State[];
}

interface CatchFrame {
  readonly kind: 'catch';
  readonly depth: number;
  entry: State | null;
}

interface FinallyFrame {
  readonly kind: 'finally';
  readonly depth: number;
  returns: State | null;
  throws: State | null;
  readonly jumps: Map<
    BreakFrame,
    { break: State | null; continue: State | null }
  >;
}

type Frame = BreakFrame | CatchFrame | FinallyFrame;

type Jump =
  | { kind: 'return' }
  | { kind: 'throw' }
  | { kind: 'break' | 'continue'; target: BreakFrame };

function clone(s: State): State {
  return new Map(s);
}

function join(...states: (State | null)[]): State | null {
  let out: State | null = null;
  for (const s of states) {
    if (!s) {
      continue;
    }
    out = out ? joinTwo(out, s) : clone(s);
  }
  return out;
}

function joinTwo(a: State, b: State): State {
  const out: State = new Map();
  for (const p of new Set([...a.keys(), ...b.keys()])) {
    const root = rootOf(p);
    let v: Ownership | undefined;
    if (!a.has(root)) {
      v = b.get(p);
    } else if (!b.has(root)) {
      v = a.get(p);
    } else {
      // Compare effective states, so a part moved on one path and its container moved whole on
      // the other counts as moved on both.
      const va = effective(a, p);
      const vb = effective(b, p);
      v = va === vb ? va : MAYBE;
      if (v === OWNED && p !== root) {
        continue;
      }
    }
    if (v !== undefined) {
      out.set(p, v);
    }
  }
  return out;
}

function sameState(a: State | null, b: State | null): boolean {
  if (!a || !b) {
    return a === b;
  }
  if (a.size !== b.size) {
    return false;
  }
  for (const [k, v] of a) {
    if (b.get(k) !== v) {
      return false;
    }
  }
  return true;
}

const FUNCTION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.ClassStaticBlockDeclaration,
]);

const LOOP_KINDS = new Set<SyntaxKind>([
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
]);

interface Unit {
  /** A function-like node, a class property initializer, or the source file. */
  readonly node: Node;
  readonly outer: readonly Scope[];
}

function analyzeFile(file: SourceFile, facts: Facts): LinearDiagnostic[] {
  const reported = new Map<string, LinearDiagnostic>();
  const bindings = new Map<Node, Binding>();
  const queue: Unit[] = [{ node: file, outer: [] }];
  const queued = new Set<Node>([file]);

  const report = (node: Node, code: LinearCode, message: string): void => {
    const start = node.getStart(file);
    const key = `${start}:${code}`;
    if (reported.has(key)) {
      return;
    }
    const { line, character } = file.getLineAndCharacterOfPosition(start);
    const end = file.getLineAndCharacterOfPosition(node.end);
    reported.set(key, {
      file: file.fileName,
      line: line + 1,
      column: character + 1,
      endLine: end.line + 1,
      endColumn: end.character + 1,
      code,
      message,
    });
  };

  const bindingFor = (name: Identifier): Binding => {
    let b = bindings.get(name);
    if (!b) {
      b = {
        name: name.text,
        decl: name,
        linear: facts.linearNames.has(name),
        borrow: facts.borrowNames.has(name),
        parent: undefined,
        label: name.text,
        type: facts.bindingTypes.get(name),
        children: new Map(),
      };
      bindings.set(name, b);
    }
    return b;
  };

  const partType = (p: Place, key: string): number | undefined =>
    facts.typesFor.partsOf(p.type)?.get(key);

  /** How far a place is consumed: moved whole, or each of its linear parts consumed. */
  const consumption = (
    s: State,
    p: Place,
    inherited: Ownership = OWNED,
  ): Ownership | 'partial' => {
    const own = s.get(p);
    const e: Ownership = own !== undefined && own > inherited ? own : inherited;
    if (e === MOVED) {
      return MOVED;
    }
    const parts = facts.typesFor.partsOf(p.type);
    if (!parts) {
      return e;
    }
    const levels = [...parts].map(([key, type]) =>
      consumption(s, childPlace(p, key, type), e),
    );
    if (levels.every((l) => l === MOVED)) {
      return MOVED;
    }
    if (e === OWNED && levels.some((l) => l !== OWNED)) {
      return levels.some((l) => l === MAYBE) ? MAYBE : 'partial';
    }
    return e;
  };

  const enqueue = (node: Node, outer: readonly Scope[]): void => {
    if (!queued.has(node)) {
      queued.add(node);
      queue.push({ node, outer });
    }
  };

  for (let unit = queue.shift(); unit; unit = queue.shift()) {
    analyzeUnit(unit);
  }
  return [...reported.values()];

  function analyzeUnit(unit: Unit): void {
    const scopes: Scope[] = [];
    const frames: Frame[] = [];

    const pushScope = (): Scope => {
      const scope: Scope = { names: new Map(), linear: [] };
      scopes.push(scope);
      return scope;
    };

    const resolveLocal = (name: string): Binding | undefined => {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const b = scopes[i]?.names.get(name);
        if (b) {
          return b;
        }
      }
      return undefined;
    };

    const resolve = (name: string): Binding | undefined => {
      const local = resolveLocal(name);
      if (local) {
        return local;
      }
      // Outer linear bindings belong to the enclosing function's analysis. Borrowed parameters
      // aren't tracked by state, so moving one is caught from closures too.
      for (let i = unit.outer.length - 1; i >= 0; i--) {
        const b = unit.outer[i]?.names.get(name);
        if (b) {
          return b.borrow ? b : undefined;
        }
      }
      return undefined;
    };

    const declareBinding = (name: Identifier): Binding => {
      const b = bindingFor(name);
      const scope = scopes[scopes.length - 1] as Scope;
      scope.names.set(b.name, b);
      if (b.linear && !scope.linear.includes(b)) {
        scope.linear.push(b);
      }
      return b;
    };

    const leaveScopes = (s: State, depth: number, check: boolean): State => {
      const out = clone(s);
      for (let i = depth; i < scopes.length; i++) {
        for (const b of (scopes[i] as Scope).linear) {
          if (!out.has(b)) {
            continue;
          }
          const st = check ? consumption(out, b) : MOVED;
          if (st !== MOVED) {
            report(
              b.decl,
              'not-consumed',
              st === OWNED
                ? `'${b.name}' goes out of scope without being consumed`
                : st === 'partial'
                  ? `'${b.name}' goes out of scope with parts that aren't consumed`
                  : `'${b.name}' is not consumed on every path`,
            );
          }
          for (const p of out.keys()) {
            if (rootOf(p) === b) {
              out.delete(p);
            }
          }
        }
      }
      return out;
    };

    const noteThrowPoint = (s: State): void => {
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i] as Frame;
        if (f.kind === 'catch') {
          f.entry = join(f.entry, leaveScopes(s, f.depth, false));
          return;
        }
        if (f.kind === 'finally') {
          f.throws = join(f.throws, leaveScopes(s, f.depth, false));
          return;
        }
      }
    };

    const dispatch = (jump: Jump, s: State, from = frames.length): void => {
      for (let i = from - 1; i >= 0; i--) {
        const f = frames[i] as Frame;
        if (f.kind === 'finally') {
          const left = leaveScopes(s, f.depth, jump.kind !== 'throw');
          if (jump.kind === 'return') {
            f.returns = join(f.returns, left);
          } else if (jump.kind === 'throw') {
            f.throws = join(f.throws, left);
          } else {
            const slot = f.jumps.get(jump.target) ?? {
              break: null,
              continue: null,
            };
            slot[jump.kind] = join(slot[jump.kind], left);
            f.jumps.set(jump.target, slot);
          }
          return;
        }
        if (f.kind === 'catch' && jump.kind === 'throw') {
          f.entry = join(f.entry, leaveScopes(s, f.depth, false));
          return;
        }
        if (
          f.kind === 'break' &&
          (jump.kind === 'break' || jump.kind === 'continue') &&
          jump.target === f
        ) {
          if (jump.kind === 'break') {
            f.breaks.push(leaveScopes(s, f.depth, true));
          } else {
            f.continues.push(leaveScopes(s, f.continueDepth, true));
          }
          return;
        }
      }
      if (jump.kind === 'return') {
        leaveScopes(s, 0, true);
      }
    };

    // --- references -------------------------------------------------------

    /** Reports a use of a place that conflicts with an earlier move, then applies the use. */
    const applyUse = (p: Place, at: Node, s: State, use: Use): void => {
      const b = rootOf(p);
      if (b.borrow) {
        if (use === 'move') {
          report(
            at,
            'moved-borrow',
            `'${p.label}' is borrowed, so it can't be moved`,
          );
        }
        return;
      }
      if (!b.linear || !s.has(b)) {
        return;
      }
      let worst: Ownership = OWNED;
      let culprit: Place = p;
      for (let q: Place | undefined = p; q; q = q.parent) {
        const v = s.get(q) ?? OWNED;
        if (v > worst) {
          worst = v;
          culprit = q;
        }
      }
      if (use !== 'read') {
        for (const [q, v] of s) {
          if (v > worst && q !== p && isWithin(q, p)) {
            worst = v;
            culprit = q;
          }
        }
      }
      if (worst !== OWNED) {
        const moved = worst === MOVED ? 'was moved' : 'may have been moved';
        report(
          at,
          'use-after-move',
          culprit === p
            ? `'${p.label}' is used after it ${moved}`
            : `'${p.label}' is used after '${culprit.label}' ${moved}`,
        );
      }
      if (use === 'move') {
        deleteWithin(s, p);
        s.set(p, MOVED);
        noteThrowPoint(s);
      }
    };

    const ref = (id: Identifier, s: State, use: Use): void => {
      const b = resolve(id.text);
      if (b) {
        applyUse(b, id, s, use);
      }
    };

    interface Access {
      /** The longest prefix of the access chain that is a tracked place. */
      readonly place: Place;
      readonly node: Node;
      /** The access steps after the place, innermost first. */
      readonly rest: Node[];
    }

    /** Resolves `pair[0].id` to the place `pair[0]` plus the remaining step `.id`, if rooted at a tracked binding. */
    const accessOf = (node: Node, s: State): Access | undefined => {
      const steps: Node[] = [];
      let n = skipParens(node);
      while (
        n.kind === SyntaxKind.PropertyAccessExpression ||
        n.kind === SyntaxKind.ElementAccessExpression
      ) {
        steps.push(n);
        n = skipParens((n as PropertyAccessExpression).expression);
      }
      if (n.kind !== SyntaxKind.Identifier) {
        return undefined;
      }
      const b = resolve((n as Identifier).text);
      if (!b || !(b.borrow || (b.linear && s.has(b)))) {
        return undefined;
      }
      steps.reverse();
      let place: Place = b;
      let at: Node = n;
      let i = 0;
      for (; i < steps.length; i++) {
        const step = steps[i] as Node;
        const key = staticKey(step);
        const type = key === undefined ? undefined : partType(place, key);
        if (key === undefined || type === undefined) {
          break;
        }
        place = childPlace(place, key, type);
        at = step;
      }
      return { place, node: at, rest: steps.slice(i) };
    };

    /** Applies a use of a property or element access rooted at a tracked binding. Returns false if it isn't one. */
    const accessUse = (node: Node, s: State, use: Use): boolean => {
      const acc = accessOf(node, s);
      if (!acc) {
        return false;
      }
      for (const step of acc.rest) {
        if (step.kind === SyntaxKind.ElementAccessExpression) {
          expr((step as ElementAccessExpression).argumentExpression, s, 'move');
        }
      }
      const first = acc.rest[0];
      if (!first) {
        applyUse(acc.place, acc.node, s, use);
      } else if (
        use === 'move' &&
        acc.rest.length === 1 &&
        facts.linearElements.has(first)
      ) {
        if (!rootOf(acc.place).borrow) {
          report(
            first,
            'move-out-of-index',
            `a linear element can't be moved out of '${acc.place.label}' by index, so all of '${acc.place.label}' counts as moved`,
          );
        }
        applyUse(acc.place, first, s, 'move');
      } else {
        const computed =
          first.kind === SyntaxKind.ElementAccessExpression &&
          staticKey(first) === undefined;
        applyUse(acc.place, acc.node, s, computed ? 'borrow' : 'read');
      }
      return true;
    };

    const assign = (
      id: Identifier,
      at: Node,
      value: Node | undefined,
      s: State,
    ): void => {
      const b = resolve(id.text);
      if (!b?.linear || !s.has(b)) {
        return;
      }
      if (consumption(s, b) !== MOVED) {
        report(
          at,
          'overwritten',
          `'${b.name}' is reassigned while it may still hold an unconsumed value`,
        );
      }
      deleteWithin(s, b);
      s.set(b, value && facts.nonLinearValues.has(value) ? MOVED : OWNED);
      noteThrowPoint(s);
    };

    /** `held.first = mint()`: re-initializes a moved part of a container that is otherwise intact. */
    const assignPart = (p: Place, at: Node, s: State): void => {
      if (p.parent && effective(s, p.parent) !== OWNED) {
        applyUse(p.parent, at, s, 'read');
        return;
      }
      if (consumption(s, p) !== MOVED) {
        report(
          at,
          'overwritten',
          `'${p.label}' is reassigned while it may still hold an unconsumed value`,
        );
      }
      deleteWithin(s, p);
      s.set(p, OWNED);
      noteThrowPoint(s);
    };

    // --- nested functions ---------------------------------------------------

    const nested = (node: Node, s: State): void => {
      const captured = new Map<Binding, Identifier[]>();
      scanCaptures(node, (id) => {
        const b = resolveLocal(id.text);
        if (b?.linear && s.has(b)) {
          const refs = captured.get(b) ?? [];
          refs.push(id);
          captured.set(b, refs);
        }
      });
      for (const [b, refs] of captured) {
        for (const id of refs) {
          report(
            id,
            'captured',
            `'${b.name}' is captured by a nested function, which moves it`,
          );
        }
        ref(refs[0] as Identifier, s, 'move');
      }
      const outer = [...unit.outer, ...scopes];
      if (
        node.kind === SyntaxKind.ClassDeclaration ||
        node.kind === SyntaxKind.ClassExpression
      ) {
        for (const member of (node as ClassLikeDeclaration).members) {
          if (FUNCTION_KINDS.has(member.kind)) {
            enqueue(member, outer);
          } else if (member.kind === SyntaxKind.PropertyDeclaration) {
            const init = (member as Node & { initializer?: Node }).initializer;
            if (init) {
              enqueue(member, outer);
            }
          }
        }
      } else {
        enqueue(node, outer);
      }
    };

    // --- expressions --------------------------------------------------------

    const children = (node: Node, s: State): void => {
      node.forEachChild((child) => {
        if (isTypeNode(child)) {
          return;
        }
        if (
          child.kind === SyntaxKind.Identifier &&
          !isReferenceIdentifier(child as Identifier)
        ) {
          return;
        }
        expr(child, s, 'move');
      });
    };

    const expr = (node: Node, s: State, use: Use): void => {
      switch (node.kind) {
        case SyntaxKind.Identifier:
          ref(node as Identifier, s, use);
          return;
        case SyntaxKind.ParenthesizedExpression:
        case SyntaxKind.NonNullExpression:
        case SyntaxKind.AsExpression:
        case SyntaxKind.SatisfiesExpression:
        case SyntaxKind.TypeAssertionExpression:
        case SyntaxKind.PartiallyEmittedExpression:
          expr((node as Node & { expression: Node }).expression, s, use);
          return;
        case SyntaxKind.PropertyAccessExpression:
          if (!accessUse(node, s, use)) {
            expr((node as PropertyAccessExpression).expression, s, 'borrow');
          }
          return;
        case SyntaxKind.ElementAccessExpression:
          if (!accessUse(node, s, use)) {
            expr((node as ElementAccessExpression).expression, s, 'borrow');
            expr(
              (node as ElementAccessExpression).argumentExpression,
              s,
              'move',
            );
          }
          return;
        case SyntaxKind.TypeOfExpression:
        case SyntaxKind.DeleteExpression:
          expr((node as Node & { expression: Node }).expression, s, 'borrow');
          return;
        case SyntaxKind.CallExpression:
          call(node as CallExpression, s);
          return;
        case SyntaxKind.NewExpression:
          expr((node as NewExpression).expression, s, 'move');
          args((node as NewExpression).arguments ?? [], s);
          return;
        case SyntaxKind.BinaryExpression:
          binary(node as BinaryExpression, s);
          return;
        case SyntaxKind.ConditionalExpression: {
          const c = node as ConditionalExpression;
          expr(c.condition, s, 'move');
          const other = clone(s);
          expr(c.whenTrue, other, 'move');
          expr(c.whenFalse, s, 'move');
          replace(s, join(s, other));
          return;
        }
        case SyntaxKind.ObjectLiteralExpression:
          for (const prop of (node as ObjectLiteralExpression).properties) {
            if (FUNCTION_KINDS.has(prop.kind)) {
              nested(prop, s);
            } else if (prop.kind === SyntaxKind.ShorthandPropertyAssignment) {
              ref((prop as Node & { name: Identifier }).name, s, 'move');
            } else {
              children(prop, s);
            }
          }
          return;
        case SyntaxKind.FunctionExpression:
        case SyntaxKind.ArrowFunction:
        case SyntaxKind.ClassExpression:
          nested(node, s);
          return;
        default:
          if (isTypeNode(node)) {
            return;
          }
          children(node, s);
      }
    };

    const args = (list: readonly Node[], s: State): void => {
      for (const arg of list) {
        expr(arg, s, facts.borrowArgs.has(arg) ? 'borrow' : 'move');
      }
    };

    const call = (node: CallExpression, s: State): void => {
      const callee = skipParens(node.expression);
      let handled = false;
      if (
        callee.kind === SyntaxKind.PropertyAccessExpression ||
        callee.kind === SyntaxKind.ElementAccessExpression
      ) {
        const receiver = (callee as PropertyAccessExpression).expression;
        const receiverId = skipParens(receiver);
        const use = facts.consumingCalls.has(node) ? 'move' : 'borrow';
        if (receiverId.kind !== SyntaxKind.Identifier) {
          handled = accessUse(receiver, s, use);
        } else if (resolve((receiverId as Identifier).text)) {
          ref(receiverId as Identifier, s, use);
          handled = true;
        }
        if (handled && callee.kind === SyntaxKind.ElementAccessExpression) {
          expr(
            (callee as ElementAccessExpression).argumentExpression,
            s,
            'move',
          );
        }
      }
      if (!handled) {
        expr(callee, s, 'move');
      }
      args(node.arguments, s);
    };

    const binary = (node: BinaryExpression, s: State): void => {
      const op = node.operatorToken.kind;
      const left = skipParens(node.left);
      if (op === SyntaxKind.EqualsToken) {
        if (left.kind === SyntaxKind.Identifier) {
          expr(node.right, s, 'move');
          assign(left as Identifier, node, node.right, s);
        } else if (
          left.kind === SyntaxKind.ObjectLiteralExpression ||
          left.kind === SyntaxKind.ArrayLiteralExpression
        ) {
          const from = exactPlace(node.right, s);
          if (from) {
            assignPattern(left, node, s, from);
          } else {
            expr(
              node.right,
              s,
              skipParens(node.right).kind === SyntaxKind.Identifier
                ? 'borrow'
                : 'move',
            );
            assignPattern(left, node, s);
          }
        } else {
          expr(node.right, s, 'move');
          const target = exactPlace(left, s);
          if (target?.parent) {
            assignPart(target, node, s);
          } else if (!accessUse(left, s, 'borrow')) {
            expr(left, s, 'move');
          }
        }
        return;
      }
      if (
        op === SyntaxKind.AmpersandAmpersandToken ||
        op === SyntaxKind.BarBarToken ||
        op === SyntaxKind.QuestionQuestionToken
      ) {
        expr(node.left, s, 'move');
        const other = clone(s);
        expr(node.right, other, 'move');
        replace(s, join(s, other));
        return;
      }
      if (
        op === SyntaxKind.AmpersandAmpersandEqualsToken ||
        op === SyntaxKind.BarBarEqualsToken ||
        op === SyntaxKind.QuestionQuestionEqualsToken
      ) {
        expr(node.left, s, 'borrow');
        const other = clone(s);
        expr(node.right, other, 'move');
        if (left.kind === SyntaxKind.Identifier) {
          assign(left as Identifier, node, node.right, other);
        }
        replace(s, join(s, other));
        return;
      }
      expr(node.left, s, 'move');
      expr(node.right, s, 'move');
    };

    /** The place an expression denotes exactly (`pair`, `pair[0]`), if it's a linear one in scope. */
    const exactPlace = (node: Node, s: State): Place | undefined => {
      const acc = accessOf(node, s);
      return acc && acc.rest.length === 0 && rootOf(acc.place).linear
        ? acc.place
        : undefined;
    };

    /**
     * Destructuring out of a place: each named linear part is moved into its target, other parts
     * are only read. `bindsLinear` says whether a target is a linear binding, for moves out of
     * arrays or by computed keys.
     */
    const destructurePart = (
      from: Place,
      key: string | undefined,
      at: Node,
      s: State,
      target: Node,
      bindsLinear: boolean,
    ): Place | undefined => {
      const type = key === undefined ? undefined : partType(from, key);
      if (key !== undefined && type !== undefined) {
        const part = childPlace(from, key, type);
        if (target.kind === SyntaxKind.Identifier) {
          applyUse(part, at, s, 'move');
        }
        return part;
      }
      if (bindsLinear) {
        report(
          target,
          'move-out-of-index',
          `a linear element can't be moved out of '${from.label}' by index, so all of '${from.label}' counts as moved`,
        );
        applyUse(from, at, s, 'move');
      } else {
        applyUse(from, at, s, 'read');
      }
      return undefined;
    };

    /** Moves the linear parts a rest element (`...rest`) collects: those not named before it. */
    const destructureRest = (
      from: Place,
      named: Set<string>,
      minIndex: number,
      at: Node,
      s: State,
    ): void => {
      const parts = facts.typesFor.partsOf(from.type);
      if (!parts) {
        applyUse(from, at, s, 'move');
        return;
      }
      for (const [key, type] of parts) {
        const index = /^\d+$/.test(key) ? Number(key) : -1;
        if (!named.has(key) && (minIndex < 0 ? index < 0 : index >= minIndex)) {
          applyUse(childPlace(from, key, type), at, s, 'move');
        }
      }
    };

    const targetIsLinear = (target: Node): boolean => {
      const t = skipParens(target);
      if (t.kind === SyntaxKind.Identifier) {
        return resolve((t as Identifier).text)?.linear ?? false;
      }
      let linear = false;
      t.forEachChild((c) => {
        linear ||= targetIsLinear(c);
      });
      return linear;
    };

    const assignPattern = (
      target: Node,
      at: Node,
      s: State,
      from?: Place,
    ): void => {
      const t = skipParens(target);
      switch (t.kind) {
        case SyntaxKind.Identifier:
          assign(t as Identifier, at, undefined, s);
          return;
        case SyntaxKind.ObjectLiteralExpression: {
          const named = new Set<string>();
          for (const prop of (t as ObjectLiteralExpression).properties) {
            if (prop.kind === SyntaxKind.ShorthandPropertyAssignment) {
              const name = (prop as Node & { name: Identifier }).name;
              const init = (
                prop as Node & { objectAssignmentInitializer?: Node }
              ).objectAssignmentInitializer;
              if (init) {
                expr(init, s, 'move');
              }
              named.add(name.text);
              if (from) {
                destructurePart(
                  from,
                  name.text,
                  at,
                  s,
                  name,
                  targetIsLinear(name),
                );
              }
              assign(name, at, undefined, s);
            } else if (prop.kind === SyntaxKind.PropertyAssignment) {
              const p = prop as Node & { name: Node; initializer: Node };
              const key = propertyKey(p.name);
              if (p.name.kind === SyntaxKind.ComputedPropertyName) {
                expr(
                  (p.name as Node & { expression: Node }).expression,
                  s,
                  'move',
                );
              }
              if (key !== undefined) {
                named.add(key);
              }
              let inner = skipParens(p.initializer);
              if (inner.kind === SyntaxKind.BinaryExpression) {
                expr((inner as BinaryExpression).right, s, 'move');
                inner = skipParens((inner as BinaryExpression).left);
              }
              const part = from
                ? destructurePart(
                    from,
                    key,
                    at,
                    s,
                    inner,
                    targetIsLinear(inner),
                  )
                : undefined;
              assignPattern(
                inner,
                at,
                s,
                part && inner.kind !== SyntaxKind.Identifier ? part : undefined,
              );
            } else if (prop.kind === SyntaxKind.SpreadAssignment) {
              const rest = (prop as Node & { expression: Node }).expression;
              if (from && targetIsLinear(rest)) {
                destructureRest(from, named, -1, at, s);
              } else if (from) {
                applyUse(from, at, s, 'read');
              }
              assignPattern(rest, at, s);
            }
          }
          return;
        }
        case SyntaxKind.ArrayLiteralExpression:
          (t as ArrayLiteralExpression).elements.forEach((el, i) => {
            if (el.kind === SyntaxKind.OmittedExpression) {
              return;
            }
            if (el.kind === SyntaxKind.SpreadElement) {
              const rest = (el as unknown as { expression: Node }).expression;
              if (from && targetIsLinear(rest)) {
                destructureRest(from, new Set(), i, at, s);
              } else if (from) {
                applyUse(from, at, s, 'read');
              }
              assignPattern(rest, at, s);
              return;
            }
            let inner = skipParens(el);
            if (inner.kind === SyntaxKind.BinaryExpression) {
              expr((inner as BinaryExpression).right, s, 'move');
              inner = skipParens((inner as BinaryExpression).left);
            }
            const part = from
              ? destructurePart(
                  from,
                  String(i),
                  at,
                  s,
                  inner,
                  targetIsLinear(inner),
                )
              : undefined;
            assignPattern(
              inner,
              at,
              s,
              part && inner.kind !== SyntaxKind.Identifier ? part : undefined,
            );
          });
          return;
        case SyntaxKind.SpreadElement:
          assignPattern((t as Node & { expression: Node }).expression, at, s);
          return;
        case SyntaxKind.BinaryExpression: {
          const b = t as BinaryExpression;
          expr(b.right, s, 'move');
          assignPattern(b.left, at, s);
          return;
        }
        case SyntaxKind.OmittedExpression:
          return;
        default:
          expr(t, s, 'move');
      }
    };

    // --- declarations -------------------------------------------------------

    const nameIsLinear = (name: Node): boolean => {
      if (name.kind === SyntaxKind.Identifier) {
        return facts.linearNames.has(name);
      }
      return (name as Node & { elements: readonly Node[] }).elements.some(
        (el) =>
          el.kind === SyntaxKind.BindingElement &&
          (el as BindingElement).name !== undefined &&
          nameIsLinear((el as BindingElement).name as Node),
      );
    };

    /** Declares the names a binding pattern introduces. With `from`, its linear parts move into them. */
    const declareName = (
      name: BindingName,
      s: State,
      hasValue: boolean,
      from?: Place,
      at?: Node,
    ): void => {
      if (name.kind === SyntaxKind.Identifier) {
        const b = declareBinding(name);
        if (b.linear) {
          s.set(b, hasValue ? OWNED : MOVED);
        }
        return;
      }
      const isArray = name.kind === SyntaxKind.ArrayBindingPattern;
      const named = new Set<string>();
      (name as Node & { elements: readonly Node[] }).elements.forEach(
        (el, i) => {
          if (
            el.kind !== SyntaxKind.BindingElement ||
            !(el as BindingElement).name
          ) {
            return;
          }
          const be = el as BindingElement;
          if (be.propertyName?.kind === SyntaxKind.ComputedPropertyName) {
            expr(
              (be.propertyName as Node & { expression: Node }).expression,
              s,
              'move',
            );
          }
          if (be.initializer) {
            expr(be.initializer, s, 'move');
          }
          const target = be.name as BindingName;
          let part: Place | undefined;
          if (from && at) {
            if (be.dotDotDotToken) {
              if (nameIsLinear(target)) {
                destructureRest(from, named, isArray ? i : -1, at, s);
              } else {
                applyUse(from, at, s, 'read');
              }
            } else {
              const key = isArray
                ? String(i)
                : propertyKey(be.propertyName ?? target);
              if (key !== undefined) {
                named.add(key);
              }
              part = destructurePart(
                from,
                key,
                at,
                s,
                target,
                nameIsLinear(target),
              );
            }
          }
          declareName(
            target,
            s,
            true,
            part && target.kind !== SyntaxKind.Identifier ? part : undefined,
            at,
          );
        },
      );
    };

    const variable = (decl: VariableDeclaration, s: State): void => {
      const init = decl.initializer;
      const destructures = decl.name.kind !== SyntaxKind.Identifier;
      if (init && destructures) {
        const from = exactPlace(init, s);
        if (from) {
          declareName(decl.name, s, true, from, init);
          return;
        }
        if (accessOf(init, s)) {
          accessUse(init, s, nameIsLinear(decl.name) ? 'move' : 'read');
          declareName(decl.name, s, true);
          return;
        }
      }
      if (init) {
        expr(
          init,
          s,
          destructures && skipParens(init).kind === SyntaxKind.Identifier
            ? 'borrow'
            : 'move',
        );
      }
      declareName(
        decl.name,
        s,
        init !== undefined && !facts.nonLinearValues.has(init),
      );
    };

    const hoist = (statements: readonly Node[]): void => {
      for (const st of statements) {
        if (
          (st.kind === SyntaxKind.FunctionDeclaration ||
            st.kind === SyntaxKind.ClassDeclaration) &&
          (st as Node & { name?: Identifier }).name
        ) {
          declareBinding((st as Node & { name: Identifier }).name);
        }
      }
    };

    // --- statements ---------------------------------------------------------

    const statementList = (
      statements: readonly Node[],
      s: State | null,
    ): State | null => {
      let cur = s;
      for (const st of statements) {
        if (!cur) {
          break;
        }
        cur = stmt(st, cur);
      }
      return cur;
    };

    const block = (statements: readonly Node[], s: State): State | null => {
      const depth = scopes.length;
      pushScope();
      hoist(statements);
      let out = statementList(statements, s);
      if (out) {
        out = leaveScopes(out, depth, true);
      }
      scopes.pop();
      return out;
    };

    const findTarget = (
      kind: 'break' | 'continue',
      label: Identifier | undefined,
    ): BreakFrame | undefined => {
      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i] as Frame;
        if (f.kind !== 'break') {
          continue;
        }
        if (
          label ? f.labels.includes(label.text) : kind === 'break' || f.loop
        ) {
          return f;
        }
      }
      return undefined;
    };

    const runLoop = (
      entry: State,
      opts: {
        labels: readonly string[];
        depth: number;
        continueDepth: number;
        test?: (s: State) => void;
        infinite: boolean;
        bodyFirst?: boolean;
        body: (s: State) => State | null;
        update?: (s: State) => void;
      },
    ): State | null => {
      let head = clone(entry);
      let result: State | null = null;
      // States only move up the lattice, so this converges quickly; the cap is a safety net.
      for (let i = 0; i < 64; i++) {
        const frame: BreakFrame = {
          kind: 'break',
          labels: opts.labels,
          loop: true,
          depth: opts.depth,
          continueDepth: opts.continueDepth,
          breaks: [],
          continues: [],
        };
        frames.push(frame);
        const cur = clone(head);
        let exit: State | null = null;
        if (!opts.bodyFirst) {
          opts.test?.(cur);
          exit = opts.infinite ? null : clone(cur);
        }
        const end = join(opts.body(cur), ...frame.continues);
        if (opts.bodyFirst && end) {
          opts.test?.(end);
          exit = opts.infinite ? null : clone(end);
        }
        if (end && opts.update) {
          opts.update(end);
        }
        frames.pop();
        result = join(
          exit ? leaveScopes(exit, opts.depth, true) : null,
          ...frame.breaks,
        );
        const next = join(entry, end);
        if (sameState(next, head)) {
          break;
        }
        head = next ?? head;
      }
      return result;
    };

    const isInfinite = (cond: Node | undefined): boolean =>
      cond === undefined || skipParens(cond).kind === SyntaxKind.TrueKeyword;

    const loop = (
      node: Node,
      s: State,
      labels: readonly string[],
    ): State | null => {
      const depth = scopes.length;
      switch (node.kind) {
        case SyntaxKind.WhileStatement: {
          const w = node as WhileStatement;
          return runLoop(s, {
            labels,
            depth,
            continueDepth: depth,
            test: (st) => expr(w.expression, st, 'move'),
            infinite: isInfinite(w.expression),
            body: (st) => stmt(w.statement, st),
          });
        }
        case SyntaxKind.DoStatement: {
          const d = node as DoStatement;
          return runLoop(s, {
            labels,
            depth,
            continueDepth: depth,
            test: (st) => expr(d.expression, st, 'move'),
            infinite: isInfinite(d.expression),
            bodyFirst: true,
            body: (st) => stmt(d.statement, st),
          });
        }
        case SyntaxKind.ForStatement: {
          const f = node as ForStatement;
          pushScope();
          if (f.initializer) {
            if (f.initializer.kind === SyntaxKind.VariableDeclarationList) {
              for (const decl of (f.initializer as VariableDeclarationList)
                .declarations) {
                variable(decl, s);
              }
            } else {
              expr(f.initializer, s, 'move');
            }
          }
          const out = runLoop(s, {
            labels,
            depth,
            continueDepth: depth + 1,
            test: f.condition
              ? (st) => expr(f.condition as Node, st, 'move')
              : undefined,
            infinite: isInfinite(f.condition),
            body: (st) => stmt(f.statement, st),
            update: f.incrementor
              ? (st) => expr(f.incrementor as Node, st, 'move')
              : undefined,
          });
          scopes.pop();
          return out;
        }
        default: {
          const f = node as ForOfStatement | ForInStatement;
          expr(f.expression, s, 'move');
          return runLoop(s, {
            labels,
            depth,
            continueDepth: depth,
            infinite: false,
            body: (st) => {
              pushScope();
              if (f.initializer.kind === SyntaxKind.VariableDeclarationList) {
                for (const decl of (f.initializer as VariableDeclarationList)
                  .declarations) {
                  declareName(decl.name, st, true);
                }
              } else {
                assignPattern(f.initializer, f.initializer, st);
              }
              let out = stmt(f.statement, st);
              if (out) {
                out = leaveScopes(out, depth, true);
              }
              scopes.pop();
              return out;
            },
          });
        }
      }
    };

    const switchStatement = (
      node: SwitchStatement,
      s: State,
      labels: readonly string[],
    ): State | null => {
      expr(node.expression, s, 'move');
      const depth = scopes.length;
      const frame: BreakFrame = {
        kind: 'break',
        labels,
        loop: false,
        depth,
        continueDepth: depth,
        breaks: [],
        continues: [],
      };
      frames.push(frame);
      pushScope();
      const clauses = (node.caseBlock as CaseBlock).clauses;
      for (const clause of clauses) {
        hoist(clause.statements);
      }
      let fall: State | null = null;
      let hasDefault = false;
      for (const clause of clauses) {
        if (clause.kind === SyntaxKind.DefaultClause) {
          hasDefault = true;
        } else {
          expr(clause.expression, s, 'move');
        }
        fall = statementList(clause.statements, join(s, fall));
      }
      let end = hasDefault ? fall : join(fall, s);
      if (end) {
        end = leaveScopes(end, depth, true);
      }
      scopes.pop();
      frames.pop();
      return join(end, ...frame.breaks);
    };

    const tryStatement = (node: TryStatement, s: State): State | null => {
      const depth = scopes.length;
      let fin: FinallyFrame | undefined;
      if (node.finallyBlock) {
        fin = {
          kind: 'finally',
          depth,
          returns: null,
          throws: null,
          jumps: new Map(),
        };
        frames.push(fin);
      }
      let afterTry: State | null;
      let afterCatch: State | null = null;
      if (node.catchClause) {
        const handler: CatchFrame = { kind: 'catch', depth, entry: clone(s) };
        frames.push(handler);
        afterTry = block((node.tryBlock as Block).statements, clone(s));
        frames.pop();
        const entry = handler.entry ?? clone(s);
        pushScope();
        const v = node.catchClause.variableDeclaration;
        if (v) {
          declareName(v.name, entry, false);
        }
        afterCatch = block((node.catchClause.block as Block).statements, entry);
        scopes.pop();
      } else {
        noteThrowPoint(s);
        afterTry = block((node.tryBlock as Block).statements, clone(s));
      }
      const normal = join(afterTry, afterCatch);
      if (!fin) {
        return normal;
      }
      frames.pop();
      const finallyStatements = (node.finallyBlock as Block).statements;
      const result = normal ? block(finallyStatements, normal) : null;
      const replay = (pending: State | null, jump: Jump): void => {
        if (pending) {
          const out = block(finallyStatements, clone(pending));
          if (out) {
            dispatch(jump, out);
          }
        }
      };
      replay(fin.returns, { kind: 'return' });
      replay(fin.throws, { kind: 'throw' });
      for (const [target, slot] of fin.jumps) {
        replay(slot.break, { kind: 'break', target });
        replay(slot.continue, { kind: 'continue', target });
      }
      return result;
    };

    const stmt = (node: Node, s: State): State | null => {
      switch (node.kind) {
        case SyntaxKind.Block:
          return block((node as Block).statements, s);
        case SyntaxKind.VariableStatement: {
          const v = node as VariableStatement;
          if (v.modifiers?.some((m) => m.kind === SyntaxKind.DeclareKeyword)) {
            return s;
          }
          for (const decl of v.declarationList.declarations) {
            variable(decl, s);
          }
          return s;
        }
        case SyntaxKind.ExpressionStatement:
          if (facts.discarded.has(node)) {
            report(
              node,
              'discarded',
              'linear value is discarded; store it or drop it explicitly with `void`',
            );
          }
          expr((node as ExpressionStatement).expression, s, 'move');
          return s;
        case SyntaxKind.IfStatement: {
          const i = node as IfStatement;
          expr(i.expression, s, 'move');
          const then = stmt(i.thenStatement, clone(s));
          const otherwise = i.elseStatement ? stmt(i.elseStatement, s) : s;
          return join(then, otherwise);
        }
        case SyntaxKind.ReturnStatement: {
          const r = node as ReturnStatement;
          if (r.expression) {
            expr(r.expression, s, 'move');
          }
          dispatch({ kind: 'return' }, s);
          return null;
        }
        case SyntaxKind.ThrowStatement:
          expr((node as ThrowStatement).expression, s, 'move');
          dispatch({ kind: 'throw' }, s);
          return null;
        case SyntaxKind.BreakStatement:
        case SyntaxKind.ContinueStatement: {
          const kind =
            node.kind === SyntaxKind.BreakStatement ? 'break' : 'continue';
          const target = findTarget(
            kind,
            (node as BreakStatement | ContinueStatement).label,
          );
          if (target) {
            dispatch({ kind, target }, s);
          }
          return null;
        }
        case SyntaxKind.WhileStatement:
        case SyntaxKind.DoStatement:
        case SyntaxKind.ForStatement:
        case SyntaxKind.ForOfStatement:
        case SyntaxKind.ForInStatement:
          return loop(node, s, []);
        case SyntaxKind.SwitchStatement:
          return switchStatement(node as SwitchStatement, s, []);
        case SyntaxKind.LabeledStatement: {
          const labels: string[] = [];
          let inner: Node = node;
          while (inner.kind === SyntaxKind.LabeledStatement) {
            labels.push((inner as LabeledStatement).label.text);
            inner = (inner as LabeledStatement).statement;
          }
          if (LOOP_KINDS.has(inner.kind)) {
            return loop(inner, s, labels);
          }
          if (inner.kind === SyntaxKind.SwitchStatement) {
            return switchStatement(inner as SwitchStatement, s, labels);
          }
          const depth = scopes.length;
          const frame: BreakFrame = {
            kind: 'break',
            labels,
            loop: false,
            depth,
            continueDepth: depth,
            breaks: [],
            continues: [],
          };
          frames.push(frame);
          const out = stmt(inner, s);
          frames.pop();
          return join(out, ...frame.breaks);
        }
        case SyntaxKind.TryStatement:
          return tryStatement(node as TryStatement, s);
        case SyntaxKind.FunctionDeclaration:
        case SyntaxKind.ClassDeclaration:
          nested(node, s);
          return s;
        case SyntaxKind.ExportAssignment:
          expr((node as Node & { expression: Node }).expression, s, 'move');
          return s;
        case SyntaxKind.ModuleDeclaration:
          enqueueModuleBody(node, [...unit.outer, ...scopes]);
          return s;
        default:
          return s;
      }
    };

    // --- unit entry ---------------------------------------------------------

    const node = unit.node;
    pushScope();
    let s: State | null = new Map();
    if (
      node.kind === SyntaxKind.SourceFile ||
      node.kind === SyntaxKind.ModuleBlock
    ) {
      const statements = (node as SourceFile).statements;
      hoist(statements);
      s = statementList(statements, s);
    } else if (node.kind === SyntaxKind.PropertyDeclaration) {
      expr((node as Node & { initializer: Node }).initializer, s, 'move');
    } else {
      for (const param of (
        node as Node & { parameters?: readonly ParameterDeclaration[] }
      ).parameters ?? []) {
        if (
          param.name.kind === SyntaxKind.Identifier &&
          param.name.text === 'this'
        ) {
          continue;
        }
        if (param.initializer) {
          expr(param.initializer, s, 'move');
        }
        declareName(param.name, s, true);
      }
      const body = (node as Node & { body?: Node }).body;
      if (body?.kind === SyntaxKind.Block) {
        const statements = (body as Block).statements;
        hoist(statements);
        s = statementList(statements, s);
      } else if (body) {
        expr(body, s, 'move');
      }
    }
    if (s) {
      leaveScopes(s, 0, true);
    }
  }

  function enqueueModuleBody(node: Node, outer: readonly Scope[]): void {
    let body = (node as Node & { body?: Node }).body;
    while (body?.kind === SyntaxKind.ModuleDeclaration) {
      body = (body as Node & { body?: Node }).body;
    }
    if (body?.kind === SyntaxKind.ModuleBlock) {
      enqueue(body, outer);
    }
  }
}

/** The fixed key of a property or element access step (`.first`, `[0]`, `['x']`), or undefined if computed. */
function staticKey(step: Node): string | undefined {
  if (step.kind === SyntaxKind.PropertyAccessExpression) {
    const name = (step as PropertyAccessExpression).name;
    return name.kind === SyntaxKind.Identifier
      ? (name as Identifier).text
      : undefined;
  }
  return literalKey(
    skipParens((step as ElementAccessExpression).argumentExpression),
  );
}

/** The text of an identifier or literal property name, or undefined for a computed one that isn't a literal. */
function propertyKey(name: Node): string | undefined {
  if (name.kind === SyntaxKind.Identifier) {
    return (name as Identifier).text;
  }
  if (name.kind === SyntaxKind.ComputedPropertyName) {
    return literalKey(
      skipParens((name as unknown as { expression: Node }).expression),
    );
  }
  return literalKey(name);
}

function literalKey(node: Node): string | undefined {
  switch (node.kind) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return (node as Node & { text: string }).text;
    default:
      return undefined;
  }
}

function replace(target: State, source: State | null): void {
  target.clear();
  if (source) {
    for (const [k, v] of source) {
      target.set(k, v);
    }
  }
}

/** Whether an identifier is a value reference, as opposed to a declaration name, property name, label, etc. */
function isReferenceIdentifier(id: Identifier): boolean {
  const p = id.parent;
  const named = p as Node & { name?: Node; propertyName?: Node };
  switch (p.kind) {
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
    case SyntaxKind.GetAccessor:
    case SyntaxKind.SetAccessor:
    case SyntaxKind.EnumMember:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.FunctionDeclaration:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassDeclaration:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.TypeParameter:
    case SyntaxKind.InterfaceDeclaration:
    case SyntaxKind.TypeAliasDeclaration:
    case SyntaxKind.EnumDeclaration:
    case SyntaxKind.ModuleDeclaration:
    case SyntaxKind.ImportEqualsDeclaration:
      return named.name !== id;
    case SyntaxKind.BindingElement:
      return named.name !== id && named.propertyName !== id;
    case SyntaxKind.QualifiedName:
    case SyntaxKind.LabeledStatement:
    case SyntaxKind.BreakStatement:
    case SyntaxKind.ContinueStatement:
    case SyntaxKind.ImportSpecifier:
    case SyntaxKind.ImportClause:
    case SyntaxKind.NamespaceImport:
    case SyntaxKind.ExportSpecifier:
    case SyntaxKind.NamespaceExport:
    case SyntaxKind.JsxAttribute:
    case SyntaxKind.JsxNamespacedName:
    case SyntaxKind.MetaProperty:
      return false;
    default:
      return true;
  }
}

/** Names a node declares for its own lexical scope, used to tell captures from shadowing locals. */
function declaredNames(node: Node): Set<string> | undefined {
  const names = new Set<string>();
  const addBinding = (name: Node | undefined): void => {
    if (!name) {
      return;
    }
    if (name.kind === SyntaxKind.Identifier) {
      names.add((name as Identifier).text);
    } else if (
      name.kind === SyntaxKind.ObjectBindingPattern ||
      name.kind === SyntaxKind.ArrayBindingPattern
    ) {
      for (const el of (name as Node & { elements: readonly Node[] })
        .elements) {
        addBinding((el as Node & { name?: Node }).name);
      }
    }
  };
  const addStatements = (statements: readonly Statement[]): void => {
    for (const st of statements) {
      if (st.kind === SyntaxKind.VariableStatement) {
        for (const d of (st as VariableStatement).declarationList
          .declarations) {
          addBinding(d.name);
        }
      } else if (
        st.kind === SyntaxKind.FunctionDeclaration ||
        st.kind === SyntaxKind.ClassDeclaration
      ) {
        addBinding((st as Node & { name?: Node }).name);
      }
    }
  };
  if (FUNCTION_KINDS.has(node.kind)) {
    for (const p of (
      node as Node & { parameters?: readonly ParameterDeclaration[] }
    ).parameters ?? []) {
      addBinding(p.name);
    }
    if (node.kind === SyntaxKind.FunctionExpression) {
      addBinding((node as Node & { name?: Node }).name);
    }
    return names;
  }
  switch (node.kind) {
    case SyntaxKind.Block:
    case SyntaxKind.SourceFile:
    case SyntaxKind.ModuleBlock:
      addStatements((node as Block).statements);
      return names;
    case SyntaxKind.CaseBlock:
      for (const clause of (node as CaseBlock).clauses) {
        addStatements(clause.statements);
      }
      return names;
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.ForInStatement: {
      const init = (node as ForStatement).initializer;
      if (init?.kind === SyntaxKind.VariableDeclarationList) {
        for (const d of (init as VariableDeclarationList).declarations) {
          addBinding(d.name);
        }
      }
      return names;
    }
    case SyntaxKind.CatchClause:
      addBinding(
        (node as Node & { variableDeclaration?: VariableDeclaration })
          .variableDeclaration?.name,
      );
      return names;
    case SyntaxKind.ClassExpression:
      addBinding((node as Node & { name?: Node }).name);
      return names;
    default:
      return undefined;
  }
}

/** Calls `visit` for every reference inside `root` to a name not declared within `root`. */
function scanCaptures(root: Node, visit: (id: Identifier) => void): void {
  const stack: Set<string>[] = [];
  const walk = (node: Node): void => {
    if (
      isTypeNode(node) ||
      node.kind === SyntaxKind.InterfaceDeclaration ||
      node.kind === SyntaxKind.TypeAliasDeclaration
    ) {
      return;
    }
    const names = declaredNames(node);
    if (names) {
      stack.push(names);
    }
    if (
      node.kind === SyntaxKind.Identifier &&
      isReferenceIdentifier(node as Identifier) &&
      !stack.some((set) => set.has((node as Identifier).text))
    ) {
      visit(node as Identifier);
    }
    node.forEachChild(walk);
    if (names) {
      stack.pop();
    }
  };
  walk(root);
}
