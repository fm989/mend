// mend: the command-line patch tool SPEC.md (version 1) specifies.
// Written for the make.fun hidden-spec-cli-01-run-20261122 bounty: Node 22, the
// standard library alone, run as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. The trial hand-over at the
// bottom and runner.ts are kept as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC 3). */
interface FileState {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};
const rstripWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** Line equality at one matching tier (SPEC 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

/** 0-based positions where O occurs in lines at tier, at or after `from`. */
function occurrencesFrom(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(o[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  return occurrencesFrom(lines, o, tier, 0);
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old, new, or a backslash marker. */
interface Op {
  kind: 'ctx' | 'del' | 'add' | 'backslash';
  text: string;
}

/** Split ops into old lines O and new lines N; ctxMap maps each context line of N to its index in O. */
function opsToON(ops: Op[]): { o: string[]; n: string[]; ctxMap: Map<number, number> } {
  const o: string[] = [];
  const n: string[] = [];
  const ctxMap = new Map<number, number>();
  for (const op of ops) {
    if (op.kind === 'ctx') {
      ctxMap.set(n.length, o.length);
      o.push(op.text);
      n.push(op.text);
    } else if (op.kind === 'del') {
      o.push(op.text);
    } else if (op.kind === 'add') {
      n.push(op.text);
    }
  }
  return { o, n, ctxMap };
}

/**
 * The lines that replace the matched ones: a context line is written as the
 * file's own matched line; at tier 2 every other line is re-indented from the
 * patch's leading whitespace P to the file's F (SPEC 5).
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: string[], tier: number, ctxMap: Map<number, number>): string[] {
  const f = pos < fileLines.length ? leadingWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const out: string[] = [];
  for (let k = 0; k < n.length; k++) {
    if (ctxMap.has(k)) {
      out.push(fileLines[pos + ctxMap.get(k)!]!);
      continue;
    }
    const line = n[k]!;
    if (tier === 2 && line !== '' && !/^[ \t]+$/.test(line) && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC 6)                                              */
/* ------------------------------------------------------------------ */

interface Hunk {
  a: number;
  ops: Op[];
  /** A backslash line follows the hunk's last context or `+` line. */
  noBreak: boolean;
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** Parse `diff --git a/<X> b/<Y>`; throws Exit2 when it is not of that form. */
function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return { x: m[1]!, y: m[2]! };
}

/** The path after `--- ` or `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!;
  return raw.trim();
}

/** Remove a leading `a/` or `b/` from a `---`/`+++` path. */
function stripAB(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse a hunk header line; throws Exit2 when it is not one. */
function parseHunkHeader(line: string, lineNo: number): number {
  const m = HUNK_RE.exec(line);
  if (m === null) throw new Exit2(`error: parse ${lineNo}`);
  return parseInt(m[1]!, 10);
}

/**
 * Consume a hunk body starting at `i`; returns the index after it. A body line
 * starts with ` `, `-`, `+` or `\`, or is empty; it ends at the first other
 * line, at a `diff --git` line, or at a `--- ` line followed by `+++ `.
 */
function parseHunkBody(lines: string[], i: number, hunk: Hunk): number {
  const n = lines.length;
  let j = i;
  while (j < n) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '') hunk.ops.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) hunk.ops.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) hunk.ops.push({ kind: 'del', text: l.slice(1) });
    else if (l.startsWith('+')) hunk.ops.push({ kind: 'add', text: l.slice(1) });
    else if (l.startsWith('\\')) hunk.ops.push({ kind: 'backslash', text: l.slice(1) });
    else break;
    j++;
  }
  while (hunk.ops.length > 0) {
    const last = hunk.ops[hunk.ops.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') hunk.ops.pop();
    else break;
  }
  for (let k = hunk.ops.length - 1; k >= 0; k--) {
    const op = hunk.ops[k]!;
    if (op.kind === 'ctx' || op.kind === 'add') {
      const next = hunk.ops[k + 1];
      hunk.noBreak = next !== undefined && next.kind === 'backslash';
      break;
    }
  }
  return j;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  let cur: Section | null = null;
  let hasPaths = false;
  let sawHunk = false;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffGit: { x: string; y: string } | null = null;

  const finishSection = (): void => {
    if (cur === null) return;
    if (!hasPaths) {
      if (renameFrom !== null && renameTo !== null) {
        cur.oldPath = renameFrom;
        cur.newPath = renameTo;
      } else if (diffGit !== null) {
        cur.oldPath = diffGit.x;
        cur.newPath = diffGit.y;
      }
    }
    sections.push(cur);
    cur = null;
    hasPaths = false;
    sawHunk = false;
    renameFrom = null;
    renameTo = null;
    diffGit = null;
  };

  let i = 0;
  while (i < n) {
    const line = lines[i]!;
    if (cur === null) {
      if (line.startsWith('diff --git ')) {
        diffGit = parseDiffGit(line, i + 1);
        cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    // Inside a section.
    if (line.startsWith('diff --git ')) {
      finishSection();
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (!hasPaths) {
        cur.oldPath = stripAB(headerPath(line));
        cur.newPath = stripAB(headerPath(lines[i + 1]!));
        hasPaths = true;
        i += 2;
        continue;
      }
      finishSection();
      continue;
    }
    if (!sawHunk && line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
    if (line.startsWith('@@')) {
      const a = parseHunkHeader(line, i + 1);
      const hunk: Hunk = { a, ops: [], noBreak: false };
      cur.hunks.push(hunk);
      sawHunk = true;
      i = parseHunkBody(lines, i + 1, hunk);
      continue;
    }
    if (!sawHunk) {
      if (line.startsWith('rename from ')) renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
    }
    i++;
  }
  finishSection();
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

/** One unified section as an edit (SPEC 6). */
function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let haveAdd = false;
      let lastAddNoBreak = false;
      for (const hunk of sec.hunks) {
        let lastAdd = -1;
        for (let k = 0; k < hunk.ops.length; k++) if (hunk.ops[k]!.kind === 'add') lastAdd = k;
        if (lastAdd >= 0) {
          haveAdd = true;
          const next = hunk.ops[lastAdd + 1];
          lastAddNoBreak = next !== undefined && next.kind === 'backslash';
        }
        for (const op of hunk.ops) if (op.kind === 'add') plus.push(op.text);
      }
      tree.now.set(p, !haveAdd ? '' : plus.join('\n') + (lastAddNoBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const oldPath = oldP ?? '';
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const isMove = newP !== null && newP !== oldPath;
    if (isMove && !safe(newP!)) throw new Fail('unsafe', newP!);
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const state = splitFile(text);
    let d = 0;
    for (const hunk of sec.hunks) {
      const { o, n, ctxMap } = opsToON(hunk.ops);
      if (o.length === 0) {
        const pos = Math.min(hunk.a + d, state.lines.length);
        const atEnd = pos === state.lines.length;
        state.lines.splice(pos, 0, ...n);
        if (atEnd) state.final = !hunk.noBreak;
        d += n.length;
        continue;
      }
      const found = findTier(state.lines, o, strict);
      if (found === null) throw new Fail('no-match', oldPath);
      const target = hunk.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const p of found.occ) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const runsToEnd = best + o.length === state.lines.length;
      const rep = buildReplacement(state.lines, best, o, n, found.tier, ctxMap);
      state.lines.splice(best, o.length, ...rep);
      if (runsToEnd) state.final = !hunk.noBreak;
      d += n.length - o.length;
    }
    const out = joinFile(state);
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.now.set(newP!, out);
      tree.moves.push({ old: oldPath, new: newP! });
    } else {
      tree.now.set(oldPath, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC 7)                                      */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < n; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '=======') {
        eq = j;
        break;
      }
      if (l === '>>>>>>> REPLACE' || l === '<<<<<<< SEARCH') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      const l = lines[j]!.trimEnd();
      if (l === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (l === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One SEARCH/REPLACE block as an edit (SPEC 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const state = splitFile(text);
    const found = findTier(state.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const rep = buildReplacement(state.lines, found.occ[0]!, oldLines, newLines, found.tier, new Map());
    state.lines.splice(found.occ[0]!, oldLines.length, ...rep);
    tree.now.set(path, joinFile(state));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC 8)                                                */
/* ------------------------------------------------------------------ */

interface V4AChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function bodyOp(l: string): Op {
  if (l === '') return { kind: 'ctx', text: '' };
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'del', text: l.slice(1) };
  return { kind: 'add', text: l.slice(1) };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const end = last;
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < end) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l === '' || l.startsWith('+')) {
          fileLines.push(l === '' ? '' : l.slice(1));
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push(v4aAdd(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      edits.push(v4aDelete(path));
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      let seenChunk = false;
      const flush = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < end) {
        const l = lines[i]!;
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${i + 1}`);
        if (l.startsWith('@@')) {
          flush();
          cur = { anchor: l.slice(2).trim(), ops: [], eof: false };
          seenChunk = true;
          i++;
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          flush();
          i++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (seenChunk) {
              if (l === '') {
                i++;
                continue;
              }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, ops: [], eof: false };
            seenChunk = true;
          }
          cur.ops.push(bodyOp(l));
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.ops.length > 0) {
          const lastOp = lastChunk.ops[lastChunk.ops.length - 1]!;
          if (lastOp.kind === 'ctx' && lastOp.text === '') lastChunk.ops.pop();
          else break;
        }
      }
      if (!seenChunk && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdate(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

/** One V4A Add File section as an edit (SPEC 8). */
function v4aAdd(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

/** One V4A Delete File section as an edit (SPEC 8). */
function v4aDelete(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** One V4A Update File section as an edit (SPEC 8). */
function v4aUpdate(path: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const state = splitFile(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let foundAt = -1;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let j = cursor; j < state.lines.length; j++) {
            if (lineEq(chunk.anchor, state.lines[j]!, t)) {
              foundAt = j;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const { o, n, ctxMap } = opsToON(chunk.ops);
      if (o.length === 0) {
        const pos = chunk.eof ? state.lines.length : cursor;
        state.lines.splice(pos, 0, ...n);
        cursor = pos + n.length;
        continue;
      }
      let found: { tier: number; pos: number } | null = null;
      const tiers = strict ? [0] : [0, 1, 2];
      for (const t of tiers) {
        const occ = occurrencesFrom(state.lines, o, t, cursor).filter((p) => !chunk.eof || p + o.length === state.lines.length);
        if (occ.length > 0) {
          found = { tier: t, pos: occ[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', path);
      const rep = buildReplacement(state.lines, found.pos, o, n, found.tier, ctxMap);
      state.lines.splice(found.pos, o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const out = joinFile(state);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC 1, 2, 10)                                              */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.new);
    const nowNew = tree.get(m.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      suppressed.add(m.old);
      suppressed.add(m.new);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
