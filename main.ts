// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths and format detection (sections 1 to 4), line matching at three tiers (section 5), unified
// diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that ran, in order: [old path, new path]. Rolled back with `now` when an edit fails. */
  readonly moves: [string, string][] = [];
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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

/* ---------- Section 3: a file as lines, its own break, and whether it ends with one ---------- */

interface FileModel {
  lines: string[];
  br: string;
  eol: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', eol: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.eol ? m.br : '');
}

/* ---------- Section 5: matching lines at three tiers ---------- */

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

function matchAt(lines: string[], o: string[], pos: number, tier: number): boolean {
  if (pos < 0 || pos + o.length > lines.length) return false;
  for (let j = 0; j < o.length; j++) if (!lineEq(lines[pos + j]!, o[j]!, tier)) return false;
  return true;
}

function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) if (matchAt(lines, o, i, tier)) out.push(i);
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

function findTier(lines: string[], o: string[], strict: boolean): { tier: number; at: number[] } | null {
  for (const tier of tiers(strict)) {
    const at = occurrences(lines, o, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk: context, old-only or new-only. `mark`: a `\` line follows it. */
interface Op {
  k: 'ctx' | 'del' | 'add';
  t: string;
  mark: boolean;
  raw?: boolean;
}

function opsOld(ops: Op[]): string[] {
  return ops.filter((o) => o.k !== 'add').map((o) => o.t);
}

function opsNewLen(ops: Op[]): number {
  return ops.filter((o) => o.k !== 'del').length;
}

/** At tier 2 a written line that is not a context line is re-indented from P (old) to F (the file's). */
function reindent(t: string, tier: number, f: string, p: string): string {
  if (tier !== 2) return t;
  if (t === '' || t.trim() === '') return t;
  return t.startsWith(p) ? f + t.slice(p.length) : t;
}

/** Replace lines[pos .. pos + O) by the ops' new lines; context lines come out as the file's own matched lines. */
function applyOps(lines: string[], ops: Op[], pos: number, tier: number): string[] {
  const o = opsOld(ops);
  const f = tier === 2 ? leadWs(lines[pos] ?? '') : '';
  const p = tier === 2 ? leadWs(o[0] ?? '') : '';
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.k === 'ctx') {
      out.push(lines[pos + oi]!);
      oi += 1;
    } else if (op.k === 'del') {
      oi += 1;
    } else {
      out.push(reindent(op.t, tier, f, p));
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

/** Replace a plain block of old lines (SEARCH/REPLACE: no context lines) at pos. */
function replacePlain(lines: string[], pos: number, oLen: number, n: string[], tier: number, oFirst: string): string[] {
  const f = tier === 2 ? leadWs(lines[pos] ?? '') : '';
  const p = tier === 2 ? leadWs(oFirst) : '';
  const mapped = n.map((t) => reindent(t, tier, f, p));
  return [...lines.slice(0, pos), ...mapped, ...lines.slice(pos + oLen)];
}

/** The `\` marker of a hunk's last context or `+` line: true when it carries one. */
function lastWriteMark(ops: Op[]): boolean {
  for (let k = ops.length - 1; k >= 0; k--) if (ops[k]!.k !== 'del') return ops[k]!.mark;
  return false;
}

/* ---------- Section 6: unified diffs ---------- */

interface Hunk {
  a: number;
  ops: Op[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string | null;
  pairNew?: string | null;
  renOld?: string;
  renNew?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

const GIT_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path a `---` or `+++` header line names: after the four characters, to the first tab, spaces removed. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.replace(/^ +| +$/g, '');
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

function applyHunks(m: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = opsOld(h.ops);
    if (o.length === 0) {
      const at = Math.min(h.a + d, m.lines.length);
      const adds = h.ops.filter((x) => x.k === 'add');
      if (adds.length > 0) {
        const atEnd = at === m.lines.length;
        m.lines = [...m.lines.slice(0, at), ...adds.map((x) => x.t), ...m.lines.slice(at)];
        if (atEnd) m.eol = !adds[adds.length - 1]!.mark;
      }
    } else {
      const f = findTier(m.lines, o, strict);
      if (f === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = f.at[0]!;
      for (const cand of f.at) if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      const reachesEnd = pos + o.length === m.lines.length;
      m.lines = applyOps(m.lines, h.ops, pos, f.tier);
      if (reachesEnd) m.eol = !lastWriteMark(h.ops);
    }
    d += opsNewLen(h.ops) - o.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const sections: Section[] = [];
  const startsGit = (l: string): boolean => l.startsWith('diff --git ');
  const startsPair = (idx: number): boolean => lines[idx]!.startsWith('--- ') && (lines[idx + 1] ?? '').startsWith('+++ ');

  /** Parse the section that starts at `start`; return the first index after it. */
  const parseSection = (start: number): number => {
    const sec: Section = { newFile: false, delFile: false, hunks: [] };
    let i = start;
    if (startsGit(lines[i]!)) {
      const m = GIT_RE.exec(lines[i]!);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec.gitOld = m[1]!;
      sec.gitNew = m[2]!;
      i += 1;
    }
    let pairSeen = false;
    while (i < n) {
      const l = lines[i]!;
      if (startsGit(l) || l.startsWith('@@')) break;
      if (l.startsWith('--- ')) {
        if (!startsPair(i)) throw new Exit2(`error: parse ${i + 2}`);
        if (pairSeen) break;
        pairSeen = true;
        sec.pairOld = headerPath(l);
        sec.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        sec.renOld = l.slice(12).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        sec.renNew = l.slice(10).trim();
        i += 1;
        continue;
      }
      if (l.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
      i += 1;
    }
    while (i < n) {
      const l = lines[i]!;
      if (startsGit(l) || startsPair(i)) break;
      if (l.startsWith('@@')) {
        const m = HUNK_RE.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(m[1]!, 10);
        i += 1;
        const ops: Op[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (startsGit(b) || startsPair(i)) break;
          const c = b[0];
          if (b === '') {
            ops.push({ k: 'ctx', t: '', mark: false, raw: true });
            i += 1;
          } else if (c === ' ') {
            ops.push({ k: 'ctx', t: b.slice(1), mark: false });
            i += 1;
          } else if (c === '-') {
            ops.push({ k: 'del', t: b.slice(1), mark: false });
            i += 1;
          } else if (c === '+') {
            ops.push({ k: 'add', t: b.slice(1), mark: false });
            i += 1;
          } else if (c === '\\') {
            const last = ops[ops.length - 1];
            if (last !== undefined) last.mark = true;
            i += 1;
          } else break;
        }
        while (ops.length > 0 && ops[ops.length - 1]!.raw === true) ops.pop();
        sec.hunks.push({ a, ops });
        continue;
      }
      i += 1;
    }
    sections.push(sec);
    return i;
  };

  let i = 0;
  while (i < n) {
    const l = lines[i]!;
    if (startsGit(l) || startsPair(i)) i = parseSection(i);
    else if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    else i += 1;
  }
  return sections.map((sec) => sectionEdit(sec, strict));
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
  const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
  if (sec.newFile || sec.pairOld === null) {
    const target = newP ?? oldP ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const ls: string[] = [];
      let lastAdd: Op | null = null;
      for (const h of sec.hunks)
        for (const op of h.ops)
          if (op.k === 'add') {
            ls.push(op.t);
            lastAdd = op;
          }
      const eol = ls.length > 0 && !(lastAdd !== null && lastAdd.mark);
      tree.now.set(target, ls.length === 0 ? '' : ls.join('\n') + (eol ? '\n' : ''));
    };
  }
  if (sec.delFile || sec.pairNew === null) {
    const target = oldP ?? newP ?? '';
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  if (oldP !== undefined && oldP !== null && newP !== undefined && newP !== null && oldP !== newP) {
    const o = oldP;
    const w = newP;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(w)) throw new Fail('unsafe', w);
      const t = tree.get(o);
      if (t === null) throw new Fail('missing', o);
      if (tree.get(w) !== null) throw new Fail('exists', w);
      const m = splitFile(t);
      applyHunks(m, sec.hunks, strict, o);
      tree.now.set(w, joinFile(m));
      tree.now.set(o, null);
      tree.moves.push([o, w]);
    };
  }
  const p = oldP ?? newP ?? '';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const m = splitFile(t);
    applyHunks(m, sec.hunks, strict, p);
    tree.now.set(p, joinFile(m));
  };
}

/* ---------- Section 7: SEARCH/REPLACE blocks ---------- */

function srEdit(p: string, oldL: string[], newL: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldL.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
      return;
    }
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    const m = splitFile(t);
    const f = findTier(m.lines, oldL, strict);
    if (f === null) throw new Fail('no-match', p);
    if (f.at.length > 1) throw new Fail('ambiguous', p);
    m.lines = replacePlain(m.lines, f.at[0]!, oldL.length, newL, f.tier, oldL[0]!);
    tree.now.set(p, joinFile(m));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let p: string | null = null;
    for (let j = searchIdx - 1; j >= scanFrom; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let k = searchIdx + 1; k < lines.length; k++) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eq = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let k = eq + 1; k < lines.length; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    edits.push(srEdit(p, lines.slice(searchIdx + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = p;
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/* ---------- Section 8: V4A patches ---------- */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      lb = k;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);

  const isStart = (l: string): boolean => l.startsWith(V_ADD) || l.startsWith(V_DEL) || l.startsWith(V_UPD);
  const edits: Edit[] = [];
  let i = fb + 1;
  while (i < lb) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (!isStart(l)) throw new Exit2(`error: parse ${i + 1}`);
    const headIdx = i;
    let j = i + 1;
    const body: { idx: number; l: string }[] = [];
    while (j < lb && !isStart(lines[j]!)) {
      body.push({ idx: j, l: lines[j]! });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.l)) body.pop();
    if (l.startsWith(V_ADD)) {
      const p = l.slice(V_ADD.length).trim();
      const content: string[] = [];
      for (const b of body) {
        if (b.l.startsWith('+')) content.push(b.l.slice(1));
        else if (b.l === '') content.push('');
        else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content.length === 0 ? '' : content.join('\n') + '\n');
      });
    } else if (l.startsWith(V_DEL)) {
      const p = l.slice(V_DEL.length).trim();
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = l.slice(V_UPD.length).trim();
      let moveTo: string | undefined;
      let rest = body;
      if (rest.length > 0 && rest[0]!.l.startsWith(V_MOVE)) {
        moveTo = rest[0]!.l.slice(V_MOVE.length).trim();
        rest = rest.slice(1);
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (const b of rest) {
        const bl = b.l;
        if (bl.startsWith('@@')) {
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
          chunks.push(cur);
        } else if (bl.trim() === '*** End of File') {
          if (cur === null) {
            cur = { anchor: null, eof: true, ops: [] };
            chunks.push(cur);
          } else cur.eof = true;
          cur = null;
        } else if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+') {
          if (cur === null) {
            cur = { anchor: null, eof: false, ops: [] };
            chunks.push(cur);
          }
          if (bl === '') cur.ops.push({ k: 'ctx', t: '', mark: false });
          else if (bl[0] === ' ') cur.ops.push({ k: 'ctx', t: bl.slice(1), mark: false });
          else if (bl[0] === '-') cur.ops.push({ k: 'del', t: bl.slice(1), mark: false });
          else cur.ops.push({ k: 'add', t: bl.slice(1), mark: false });
        } else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${headIdx + 1}`);
      edits.push(v4aUpdate(p, moveTo, chunks, strict));
    }
    i = j;
  }
  return edits;
}

function v4aUpdate(p: string, moveTo: string | undefined, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const m = splitFile(t);
    const state = { cursor: 0 };
    for (const chunk of chunks) applyChunk(m, chunk, state, strict, p);
    if (moveTo !== undefined) {
      tree.now.set(moveTo, chunks.length > 0 ? joinFile(m) : t);
      tree.now.set(p, null);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, joinFile(m));
    }
  };
}

function applyChunk(m: FileModel, chunk: VChunk, state: { cursor: number }, strict: boolean, path: string): void {
  let start = state.cursor;
  if (chunk.anchor !== null) {
    let found = -1;
    for (const tier of tiers(strict)) {
      for (let k = state.cursor; k < m.lines.length; k++) {
        if (lineEq(m.lines[k]!, chunk.anchor, tier)) {
          found = k;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found < 0) throw new Fail('no-match', path);
    start = found + 1;
  }
  const o = opsOld(chunk.ops);
  const adds = chunk.ops.filter((x) => x.k === 'add');
  if (o.length === 0) {
    const at = chunk.eof ? m.lines.length : start;
    m.lines = [...m.lines.slice(0, at), ...adds.map((x) => x.t), ...m.lines.slice(at)];
    state.cursor = at + adds.length;
    return;
  }
  if (chunk.eof) {
    const pos = m.lines.length - o.length;
    if (pos < start) throw new Fail('no-match', path);
    let tier = -1;
    for (const t of tiers(strict)) {
      if (matchAt(m.lines, o, pos, t)) {
        tier = t;
        break;
      }
    }
    if (tier < 0) throw new Fail('no-match', path);
    m.lines = applyOps(m.lines, chunk.ops, pos, tier);
    state.cursor = pos + opsNewLen(chunk.ops);
    return;
  }
  let res: { tier: number; pos: number } | null = null;
  for (const t of tiers(strict)) {
    const at = occurrences(m.lines, o, t).filter((x) => x >= start);
    if (at.length > 0) {
      res = { tier: t, pos: at[0]! };
      break;
    }
  }
  if (res === null) throw new Fail('no-match', path);
  m.lines = applyOps(m.lines, chunk.ops, res.pos, res.tier);
  state.cursor = res.pos + opsNewLen(chunk.ops);
}

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const current = (p: string): string | null => (tree.now.has(p) ? tree.now.get(p)! : tree.original(p));
  const consumed = new Set<string>();
  const rows: { key: string; line: string }[] = [];
  for (const [o, w] of tree.moves) {
    if (consumed.has(o) || consumed.has(w)) continue;
    if (tree.original(o) !== null && current(o) === null && tree.original(w) === null && current(w) !== null) {
      rows.push({ key: w, line: `R ${o} -> ${w}` });
      consumed.add(o);
      consumed.add(w);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now || consumed.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
