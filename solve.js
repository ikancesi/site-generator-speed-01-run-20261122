// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from scratch from the README semantics: same answers, byte for byte,
// much less work. No vendor code, no dependencies, no network, no clock, no
// randomness; run(input) is a pure function of its input.
//
// Where the time goes in the reference, and what this does instead:
//  - inline Markdown escaped every single character with a regex replace:
//    this scans plain runs and escapes them in bulk (one native regex scan).
//  - templates were interpreted node by node with a scope-chain walk per
//    variable: templates are compiled once to JS functions with pre-resolved
//    paths, array-push output and a mutable flat scope (save/restore loops).
//  - slugify re-ran NFKD + combining-mark removal on every title/tag/heading:
//    results are cached, and pure-ASCII text skips normalisation entirely.
//  - cards were rebuilt for every page and tag list: each source's card is
//    built once and shared; word counts are a single char scan, not a regex
//    match that allocates every word.
//  - front matter split and re-joined the whole body: the closing line is
//    found with indexOf and only the small front-matter region is split.

const RESERVED = ['posts', 'tags', 'page'];
const HO = Object.prototype.hasOwnProperty;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// ------------------------------------------------------------------ text

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g; // for escInto's exec scan (lastIndex set per call)
const ESC_RE2 = /[&<>"']/g; // for esc's replace

/** Escape the slice s[a..b) into out (one native scan, chunks pushed raw). */
function escInto(out, s, a, b) {
  if (a >= b) return;
  ESC_RE.lastIndex = a;
  let last = a;
  let m;
  while ((m = ESC_RE.exec(s)) !== null) {
    if (m.index >= b) break;
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(ESC_MAP[m[0]]);
    last = m.index + 1;
  }
  if (last < b) out.push(s.slice(last, b));
}

/** Escape a whole string. */
function esc(s) {
  return s.replace(ESC_RE2, (c) => ESC_MAP[c]);
}

/** Whitespace table for code units (JS \s). */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff])
  WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** True for a code unit that is JS whitespace (\s). */
const isWSCode = (c) => WS_TABLE[c] === 1;

/** Count runs of non-whitespace in text (wordsOf). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) inWord = false;
    else if (!inWord) {
      n++;
      inWord = true;
    }
  }
  return n;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const longCache = new Map();
function longDate(date) {
  let s = longCache.get(date);
  if (s === undefined) {
    s = `${+date.slice(8, 10)} ${MONTHS[+date.slice(5, 7) - 1]} ${date.slice(0, 4)}`;
    longCache.set(date, s);
  }
  return s;
}

const NON_ASCII = /[^\x00-\x7F]/;
const MARK_RE = /\p{M}/gu;

function slugifySlow(text) {
  // NFKD + combining-mark removal only matters outside ASCII.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** Slug of text, cached per build (titles, tags and headings repeat a lot). */
function slugify(text, ctx) {
  let s = ctx.slugCache.get(text);
  if (s === undefined) {
    s = slugifySlow(text);
    ctx.slugCache.set(text, s);
  }
  return s;
}

/** slug made unique against taken (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** rel (a link's path) from directory dir, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ------------------------------------------------------------ front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34)
      return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1)
          return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? +m[1] : 0;
      const mo = m ? +m[2] : 0;
      const d = m ? +m[3] : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo))
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']'))
        return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t)))
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true'
        ? { value: true }
        : raw === 'false'
          ? { value: false }
          : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64
        ? { value: raw }
        : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** { data, body } or { error }; text already has "\n" line ends. */
function parseFM(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing line "---" with indexOf: it must start right after a "\n"
  // and be followed by "\n" or the end of the text.
  let pos = text.indexOf('\n---', 3);
  let closeEnd = -1;
  while (pos !== -1) {
    const after = pos + 4;
    if (after === text.length) {
      closeEnd = text.length;
      break;
    }
    if (text.charCodeAt(after) === 10) {
      closeEnd = after + 1;
      break;
    }
    pos = text.indexOf('\n---', pos + 1);
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  const region = text.slice(4, pos);
  const lines = region === '' ? [] : region.split('\n');
  const data = {};
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (line === '' || FM_BLANK.test(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd) };
}

// ----------------------------------------------------------------- markdown

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS_RE = /\s/;

const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;

/** Resolve a link target for the source env {ctx, dir, src}; records broken links. */
function linkHref(env, target) {
  if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35)
    return target;
  const key = env.dir + '\0' + target;
  const cached = env.ctx.linkCache.get(key);
  if (cached !== undefined) {
    if (cached === null) env.ctx.broken.add(`broken-link ${env.src} -> ${target}`);
    return cached === null ? target : cached;
  }
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  let path = null;
  if (rel !== '') path = resolvePath(env.dir, rel);
  let href = null;
  if (path !== null && env.ctx.bySource.has(path)) href = env.ctx.bySource.get(path).url + frag;
  else if (path !== null && env.ctx.statics.has(path)) href = env.ctx.base + '/' + path + frag;
  if (href === null) {
    env.ctx.linkCache.set(key, null);
    env.ctx.broken.add(`broken-link ${env.src} -> ${target}`);
    return target;
  }
  env.ctx.linkCache.set(key, href);
  return href;
}

/** First index >= from where s holds what outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && isEscapable(s.charCodeAt(j + 1))) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters that can start an inline construct (backslash included, so
 *  escapes are always met in left-to-right order). */
const MD_RE = /[\\`*[]/g;

/** Render s[a..b) inline into out; plain runs are escaped in bulk.
 *  The native regex jumps from one special character to the next instead of
 *  a per-character JS loop; a backslash is in the class, so an escaped
 *  special is always met as the backslash first, exactly as a scan would. */
function inlineRange(s, a, b, env, out) {
  let i = a;
  let plain = a;
  MD_RE.lastIndex = a;
  for (;;) {
    const m = MD_RE.exec(s);
    if (m === null || m.index >= b) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < b && isEscapable(s.charCodeAt(j + 1))) {
        if (j > plain) escInto(out, s, plain, j);
        out.push(s[j + 1]);
        i = j + 2;
        plain = i;
      } else {
        i = j + 1;
      }
      MD_RE.lastIndex = i;
      continue;
    }
    if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < b && k > j + 1) {
        if (j > plain) escInto(out, s, plain, j);
        out.push('<code>');
        escInto(out, s, j + 1, k);
        out.push('</code>');
        i = k + 1;
        plain = i;
      } else {
        i = j + 1;
      }
      MD_RE.lastIndex = i;
      continue;
    }
    if (c === 42) {
      if (j + 1 < b && s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2, b);
        if (k !== -1 && k > j + 2) {
          if (j > plain) escInto(out, s, plain, j);
          out.push('<strong>');
          inlineRange(s, j + 2, k, env, out);
          out.push('</strong>');
          i = k + 2;
          plain = i;
        } else {
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1, b);
        if (k !== -1 && k > j + 1) {
          if (j > plain) escInto(out, s, plain, j);
          out.push('<em>');
          inlineRange(s, j + 1, k, env, out);
          out.push('</em>');
          i = k + 1;
          plain = i;
        } else {
          i = j + 1;
        }
      }
      MD_RE.lastIndex = i;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1, b);
    let m2 = -1;
    if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
      m2 = s.indexOf(')', k + 2);
      if (m2 === -1 || m2 >= b) m2 = -1;
    }
    if (m2 !== -1) {
      const target = s.slice(k + 2, m2);
      if (target !== '' && !WS_RE.test(target)) {
        const href = linkHref(env, target);
        if (j > plain) escInto(out, s, plain, j);
        out.push('<a href="');
        escInto(out, href, 0, href.length);
        out.push('">');
        inlineRange(s, j + 1, k, env, out);
        out.push('</a>');
        i = m2 + 1;
        plain = i;
        MD_RE.lastIndex = i;
        continue;
      }
    }
    i = j + 1;
    MD_RE.lastIndex = i;
  }
  if (plain < b) escInto(out, s, plain, b);
}

function inlineStr(s, env) {
  const out = [];
  inlineRange(s, 0, s.length, env, out);
  return out.join('');
}

// ---- block classification (char-code checks, no per-line regexes) ----

function isBlank(line) {
  if (line.length === 0) return true;
  const c = line.charCodeAt(0);
  if (c !== 32 && c !== 9) return false;
  for (let j = 1; j < line.length; j++) {
    const d = line.charCodeAt(j);
    if (d !== 32 && d !== 9) return false;
  }
  return true;
}

/** Fence open: language ("" when none), or null when the line is not one. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96)
    return null;
  let j = 3;
  const len = line.length;
  while (j < len) {
    const c = line.charCodeAt(j);
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 95 ||
      c === 43 ||
      c === 45
    )
      j++;
    else break;
  }
  const langEnd = j;
  while (j < len) {
    const c = line.charCodeAt(j);
    if (c === 32 || c === 9) j++;
    else return null;
  }
  return line.slice(3, langEnd);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96)
    return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading: [depth, textStart, textEnd], or null. */
function headingRange(line) {
  let d = 0;
  const len = line.length;
  while (d < len && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6 || d === len) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let s = d;
  while (s < len && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  if (s === len) return null;
  let e = len;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return [d, s, e];
}

function isHr(line) {
  if (line.length < 3) return false;
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Bullet marker: text starts at 2, or -1. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return 2;
  return -1;
}

/** Ordered marker: [digits, textStart], or null. */
function orderedOf(line) {
  let j = 0;
  const len = line.length;
  while (j < len && j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== 32) return null;
  return [line.slice(0, j), j + 2];
}

/** A line of 2+ spaces then a non-space: a list item's continuation. */
function isContinued(line) {
  let j = 0;
  const len = line.length;
  while (j < len && line.charCodeAt(j) === 32) j++;
  if (j < 2 || j >= len) return false;
  return !isWSCode(line.charCodeAt(j));
}

/** Trim spaces/tabs at both ends of line[a..b): the trimmed range. */
function trimRange(line, a, b) {
  let s = a;
  let e = b;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return [s, e];
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a break.
 *  Only the first character can start one of those, so dispatch on it. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 35) return headingRange(line) !== null;
  if (c0 === 96) return fenceOpen(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  return false;
}

/** Render a list starting at lines[i] into out; returns the next line index. */
function renderList(lines, i, n, isOrd, start, env, out) {
  const items = [];
  while (i < n) {
    const l = lines[i];
    if (isOrd) {
      const o = orderedOf(l);
      if (o !== null) {
        const r = trimRange(l, o[1], l.length);
        items.push([l.slice(r[0], r[1])]);
        i++;
        continue;
      }
    } else if (bulletOf(l) !== -1) {
      const r = trimRange(l, 2, l.length);
      items.push([l.slice(r[0], r[1])]);
      i++;
      continue;
    }
    if (isContinued(l)) {
      const r = trimRange(l, 0, l.length);
      items[items.length - 1].push(l.slice(r[0], r[1]));
      i++;
      continue;
    }
    break;
  }
  const tag = isOrd ? 'ol' : 'ul';
  out.push(isOrd && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
  for (const it of items) {
    const text = it.join('\n');
    out.push('<li>');
    inlineRange(text, 0, text.length, env, out);
    out.push('</li>\n');
  }
  out.push(`</${tag}>\n`);
  return i;
}

/** Render a body: { html, toc, excerpt }. Blocks dispatch on the line's
 *  first character: only it can start a fence, heading, break, quote or
 *  list, so a line opening on anything else is a paragraph at once. */
function renderMd(body, env) {
  const lines = body.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === 35) {
      const h = headingRange(line);
      if (h !== null) {
        const depth = h[0];
        const text = line.slice(h[1], h[2]);
        const id = uniqueSlug(slugify(text, env.ctx), ids);
        const html = inlineStr(text, env);
        out.push(`<h${depth} id="${id}">${html}</h${depth}>\n`);
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const bodyLines = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        bodyLines.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        i++;
      }
      const q = [];
      for (const l of bodyLines) {
        const r = trimRange(l, 0, l.length);
        if (r[1] > r[0]) q.push(l.slice(r[0], r[1]));
      }
      if (q.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        const text = q.join('\n');
        out.push('<blockquote>\n<p>');
        inlineRange(text, 0, text.length, env, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 === 96) {
      const fenceLang = fenceOpen(line);
      if (fenceLang !== null) {
        i++;
        const parts = ['<pre><code'];
        if (fenceLang !== '') parts.push(' class="language-', fenceLang, '"');
        parts.push('>');
        while (i < n && !isFenceClose(lines[i])) {
          escInto(parts, lines[i], 0, lines[i].length);
          parts.push('\n');
          i++;
        }
        i++;
        parts.push('</code></pre>');
        out.push(parts.join('') + '\n');
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(line)) {
        out.push('<hr>\n');
        i++;
        continue;
      }
      if (bulletOf(line) !== -1) {
        i = renderList(lines, i, n, false, 1, env, out);
        continue;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const ord = orderedOf(line);
      if (ord !== null) {
        i = renderList(lines, i, n, true, Number(ord[0]), env, out);
        continue;
      }
    }
    // A paragraph: its lines, trimmed, joined by "\n".
    const r0 = trimRange(line, 0, line.length);
    const parts = [line.slice(r0[0], r0[1])];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      const r = trimRange(lines[i], 0, lines[i].length);
      parts.push(lines[i].slice(r[0], r[1]));
      i++;
    }
    const text = parts.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, env);
      excerpt = html;
      out.push(`<p>${html}</p>\n`);
    } else {
      out.push('<p>');
      inlineRange(text, 0, text.length, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!T_PATH.test(text))
    throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function onlySpaces(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Tokenize a template: text, {{ }}, {{{ }}} and {% %} (standalone tag lines). */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1)
        throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({
        t: raw ? 'raw' : 'var',
        path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()),
      });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone =
      onlySpaces(src, lineStart, open) && onlySpaces(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** Parse a template source into nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null)
          throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if'))
          throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body =
          parent.kind === 'root'
            ? parent.body
            : parent.kind === 'for'
              ? parent.body
              : (parent.else ?? parent.then);
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1)
    throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ---- rendering helpers (shared by compiled templates and the fallback) ----

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const HELPERS = { esc, t: textOf, y: truthy };

/** The value at path in the scope chain (interpreter fallback). */
function lookupInterp(S, V, path) {
  let v;
  if (HO.call(S, path[0])) v = S[path[0]];
  else if (HO.call(V, path[0])) v = V[path[0]];
  else return undefined;
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !HO.call(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** Tree-walking renderer (only used if a template cannot be compiled). */
function renderInterp(nodes, O, V, S, T, H, D) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        O.push(n.text);
        break;
      case 'var':
        O.push(H.esc(H.t(lookupInterp(S, V, n.path))));
        break;
      case 'raw':
        O.push(H.t(lookupInterp(S, V, n.path)));
        break;
      case 'if': {
        const v = H.y(lookupInterp(S, V, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInterp(branch, O, V, S, T, H, D);
        break;
      }
      case 'for': {
        const xs = lookupInterp(S, V, n.path);
        if (!Array.isArray(xs)) break;
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const o1 = S[n.name];
        const o2 = S.loop;
        S.loop = loop;
        for (let k = 0; k < xs.length; k++) {
          if (n.name !== 'loop') S[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderInterp(n.body, O, V, S, T, H, D);
        }
        S[n.name] = o1;
        S.loop = o2;
        break;
      }
      case 'include': {
        const t = T.get(n.name);
        if (t !== undefined && D < 8) t(O, V, S, T, H, D + 1, HO);
        break;
      }
    }
  }
}

// ---- code generation: templates compiled to JS functions ----

/** JS expression for a path; bound holds the loop names in lexical scope. */
function pathExpr(path, bound) {
  const first = path[0];
  let e;
  if (bound.has(first)) e = `S[${JSON.stringify(first)}]`;
  else
    e =
      `(HO.call(S,${JSON.stringify(first)})?S[${JSON.stringify(first)}]` +
      `:HO.call(V,${JSON.stringify(first)})?V[${JSON.stringify(first)}]:undefined)`;
  for (let k = 1; k < path.length; k++) {
    e =
      `((_v=${e})==null||typeof _v!=="object"||!HO.call(_v,${JSON.stringify(path[k])})` +
      `?undefined:_v[${JSON.stringify(path[k])}])`;
  }
  return e;
}

/** Path leaves whose value is always a number, a boolean, a validated date
 *  string or a slug (or undefined) in this data model, so escaping it is
 *  the identity and the esc call can be skipped. */
const SAFE_LEAF = new Set([
  'date', 'date_long', 'reading_minutes', 'number', 'total', 'index', 'first',
  'last', 'length', 'count', 'level', 'id', 'slug', 'is_post',
]);

function genNodes(nodes, parts, bound) {
  for (const n of nodes) {
    if (n.kind === 'text') parts.push(`O.push(${JSON.stringify(n.text)});`);
    else if (n.kind === 'var')
      parts.push(
        SAFE_LEAF.has(n.path[n.path.length - 1])
          ? `O.push(H.t(${pathExpr(n.path, bound)}));`
          : `O.push(H.esc(H.t(${pathExpr(n.path, bound)})));`,
      );
    else if (n.kind === 'raw') parts.push(`O.push(H.t(${pathExpr(n.path, bound)}));`);
    else if (n.kind === 'if') {
      parts.push(`if(H.y(${pathExpr(n.path, bound)})!==${n.not}){`);
      genNodes(n.then, parts, bound);
      if (n.else !== null) {
        parts.push('}else{');
        genNodes(n.else, parts, bound);
      }
      parts.push('}');
    } else if (n.kind === 'for') {
      const nm = JSON.stringify(n.name);
      parts.push('{');
      parts.push(`const _xs=${pathExpr(n.path, bound)};`);
      parts.push('if(Array.isArray(_xs)){');
      parts.push('const _L={index:0,first:false,last:false,length:_xs.length};');
      parts.push(`const _o1=S[${nm}];const _o2=S["loop"];S["loop"]=_L;`);
      parts.push('for(let _k=0;_k<_xs.length;_k++){');
      if (n.name !== 'loop') parts.push(`S[${nm}]=_xs[_k];`);
      parts.push('_L.index=_k+1;_L.first=_k===0;_L.last=_k===_xs.length-1;');
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      genNodes(n.body, parts, inner);
      parts.push('}');
      parts.push(`S[${nm}]=_o1;S["loop"]=_o2;`);
      parts.push('}}');
    } else if (n.kind === 'include') {
      const nm = JSON.stringify(n.name);
      parts.push(`{const _t=T.get(${nm});if(_t!==undefined&&D<8)_t(O,V,S,T,H,D+1,HO);}`);
    }
  }
}

/** Compile parsed nodes to a render function (O,V,S,T,H,D,HO). */
function buildFn(nodes) {
  const parts = ['let _v;'];
  genNodes(nodes, parts, new Set());
  return new Function('O', 'V', 'S', 'T', 'H', 'D', 'HO', parts.join('\n'));
}

const templateCache = new Map();

/** Parse + compile a template; cached by source. Throws TemplateError. */
function compileTemplate(name, src) {
  let fn = templateCache.get(src);
  if (fn !== undefined) return fn;
  const nodes = parseTemplate(name, src);
  try {
    fn = buildFn(nodes);
  } catch {
    fn = (O, V, S, T, H, D, ho) => renderInterp(nodes, O, V, S, T, H, D);
  }
  templateCache.set(src, fn);
  return fn;
}

// -------------------------------------------------------------------- build

function linkOf(s) {
  return s === null
    ? null
    : {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };
}

/** One site's output tree: path -> text. */
export function run(input) {
  const ctx = {
    base: input.site.base_url.replace(/\/+$/, ''),
    slugCache: new Map(),
    linkCache: new Map(),
    broken: new Set(),
    bySource: new Map(),
    statics: new Set(),
  };
  const env = { ctx, dir: '', src: '' };

  // Templates, parsed in code-unit order of their name.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  // 1. Sources, in code-unit order of their paths; .md is a source, else static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text =
        f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      sources.push({ path: f.path, text });
    } else {
      statics.push({ path: f.path, content: f.content });
      ctx.statics.add(f.path);
    }
  }

  // 2. Front matter: refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, ctx), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${ctx.base}/${s.outDir}/`;
    ctx.bySource.set(s.path, s);
  }

  // 4. Markdown, links resolved to pages and static files.
  for (const s of sources) {
    env.dir = dirOf(s.path);
    env.src = s.path;
    const md = renderMd(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags, grouped by slug, ordered by count then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, ctx);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, ctx);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${ctx.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources)
    if (!s.post)
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name, ctx);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
  const tags = [...bySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // 7. Layouts: every page through its layout, the index, tag and tags pages.
  // Each source's card is built once and shared by its page, the lists and tags.
  for (const s of sources) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  }
  const site = { title: input.site.title, base_url: ctx.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const output = {};
  // One top-level vars object and one scope object per case, reused across
  // renders: the four per-render keys are set (to undefined when absent),
  // which a lookup reads exactly as a missing key, and every loop restores
  // the scope it borrowed, so no render can see another's bindings.
  const V0 = { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined };
  const S0 = {};
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    V0.page = vars.page;
    V0.posts = vars.posts;
    V0.pager = vars.pager;
    V0.tag = vars.tag;
    const O = [];
    fn(O, V0, S0, templates, HELPERS, 0, HO);
    return O.join('');
  };
  const pageOf = (s) => {
    const c = s.card;
    return {
      title: c.title,
      url: c.url,
      date: c.date,
      date_long: c.date_long,
      summary: c.summary,
      excerpt: c.excerpt,
      reading_minutes: c.reading_minutes,
      tags: c.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${ctx.base}/` : `${ctx.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pages,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pages ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report.
  const lines = [...report, ...ctx.broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(
    `built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`,
  );
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
