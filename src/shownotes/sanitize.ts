// Show notes for display (PROTOCOL §12). DOMPurify keeps
// an explicit allowlist and hooks apply the URL rules; the result is checked
// again before use, so a DOM that DOMPurify cannot walk fails closed. Then
// Android 3.12.1's ShownotesCleaner runs on what is left: plain-text line
// breaks, plain-text links, and timecodes that seek.
//
// Android's java.util.regex is ICU with Unicode classes: \d is any decimal
// digit and \b uses ICU's word set, looking through combining marks and
// format characters. The patterns below spell that out.
import DOMPurify, { type Config, type WindowLike } from "dompurify";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const INT_MAX = 2147483647;
const ELEMENT = 1;
const TEXT = 3;

export const allowedTags: readonly string[] = [
  "p", "br", "b", "strong", "i", "em", "u", "s", "blockquote", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "a", "img", "hr", "pre", "code", "span", "div",
];

/** The attributes kept from the notes, per element; every other element keeps none. */
export const allowedAttributes: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["a", new Set(["href"])],
  ["img", new Set(["src", "alt", "width", "height"])],
]);

export const purifyConfig: Config & { RETURN_DOM: true } = {
  ALLOWED_TAGS: [...allowedTags],
  ALLOWED_ATTR: ["href", "src", "alt", "width", "height"],
  ALLOWED_NAMESPACES: [HTML_NS],
  ALLOWED_URI_REGEXP: /^(?:https:|mailto:)/i,
  ADD_URI_SAFE_ATTR: ["width", "height"],
  FORBID_ATTR: ["style", "srcset", "id", "class"],
  ALLOW_ARIA_ATTR: false,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  KEEP_CONTENT: true,
  SAFE_FOR_XML: true,
  RETURN_DOM: true,
};
for (const v of Object.values(purifyConfig)) if (Array.isArray(v)) Object.freeze(v);
Object.freeze(purifyConfig);

const tags = new Set(allowedTags);

export interface SanitizeOptions {
  /** origin is the app's origin (location.origin); URLs to its host are dropped. */
  origin: string;
  /** durationMs is the media's duration, 0 when unknown; omit it for an episode without media. */
  durationMs?: number;
}

/**
 * sanitize returns the notes as HTML for a container's innerHTML. Timecodes
 * are <button type="button" data-timecode="ms"> elements for the container to
 * handle. It throws if the result would hold anything outside the allowlist.
 */
export function sanitize(html: string, opts: SanitizeOptions): string {
  const { origin } = opts;
  const purify = DOMPurify(window as unknown as WindowLike);
  if (!purify.isSupported) throw new Error("shownotes: DOMPurify cannot run here");
  purify.addHook("uponSanitizeAttribute", (node, data) => {
    const tag = node.nodeName.toLowerCase();
    if (!allowedAttributes.get(tag)?.has(data.attrName)) {
      data.keepAttr = false;
      return;
    }
    if (data.attrName === "href" || data.attrName === "src") {
      const url = safeURL(data.attrValue, tag === "a" ? "link" : "image", origin);
      if (url === null) data.keepAttr = false;
      else data.attrValue = url;
    }
  });
  purify.addHook("afterSanitizeAttributes", (node) => {
    if (node.nodeName === "A" && node.hasAttribute("href")) {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    } else if (node.nodeName === "IMG") {
      if (node.hasAttribute("src")) node.setAttribute("referrerpolicy", "no-referrer");
      else node.remove();
    }
  });
  // RETURN_DOM gives the body element of DOMPurify's own document, or null
  // when the notes parse into a document without one (a frameset).
  const body = purify.sanitize(withLineBreaks(html), purifyConfig) as HTMLElement | null;
  if (!body) return "";
  verify(body, origin);
  linkify(body, origin);
  addTimecodes(body, opts.durationMs);
  return body.innerHTML;
}

export type URLKind = "link" | "image";

/**
 * safeURL returns value in its normalized form if it is an absolute https:
 * URL (or mailto: for a link) to a host other than the app's, without
 * credentials. Otherwise it returns null.
 */
export function safeURL(value: string, kind: URLKind, origin: string): string | null {
  let url: URL;
  let app: URL;
  try {
    app = new URL(origin);
    url = new URL(value);
    // "https:path" parses alone but is relative to an https page.
    if (new URL(value, app).href !== url.href) return null;
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return kind === "link" ? url.href : null;
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  // Cookies are per host, not per origin, so another port of the app's host is refused too.
  if (hostOf(url) === hostOf(app)) return null;
  return url.href;
}

/**
 * externalLink returns a link from a feed that opens outside the app (an
 * episode's website, a chapter's link) in normalized form, or null: an
 * absolute http: or https: URL without credentials to a host other than the
 * app's.
 */
export function externalLink(value: string, origin: string): string | null {
  let url: URL;
  let app: URL;
  try {
    app = new URL(origin);
    url = new URL(value);
    if (new URL(value, app).href !== url.href) return null;
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") return null;
  if (hostOf(url) === hostOf(app)) return null;
  return url.href;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/\.$/, "");
}

/** withLineBreaks is Android's rule: notes without <br> or <p> keep their line breaks. */
export function withLineBreaks(html: string): string {
  return /<br *\/?>/.test(html) || html.includes("<p>") ? html : html.replaceAll("\n", "<br />");
}

// ICU's \w, and the characters its \b looks through.
const WORD = String.raw`\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}`;
const SKIP = String.raw`\p{Grapheme_Extend}\p{Cf}`;
const BEFORE_WORD = `(?<!(?![${SKIP}])[${WORD}][${SKIP}]*)`; // \b before a word character
const AFTER_WORD = `(?![${WORD}${SKIP}])`; // \b after a word character

// The look-ahead keeps the look-behind to positions where a timecode can start.
const TIMECODE = new RegExp(String.raw`(?=\p{Nd})${BEFORE_WORD}((\p{Nd}+):)?(\p{Nd}+):(\p{Nd}{2})${AFTER_WORD}`, "gu");
const LINK = new RegExp(
  String.raw`(?:https?://(?:www\.)?|www\.)[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z]{2,6}${AFTER_WORD}[-a-zA-Z0-9@:%_+.*~#?!&$/=()\[\],;]*`,
  "giu",
);
const NOT_LINK_END = ".,;:?!)([]-_~#@$*+";

/** linkify makes plain-text URLs outside links into links (PlainTextLinksConverter), where the URL rules allow. */
export function linkify(root: Element, origin: string): void {
  const doc = root.ownerDocument;
  for (const node of textNodes(root, true)) {
    replaceMatches(node, LINK, (m) => {
      const found = m[0];
      if (NOT_LINK_END.includes(found.charAt(found.length - 1))) return null;
      const href = safeURL(/^https?:\/\//i.test(found) ? found : `https://${found}`, "link", origin);
      if (href === null) return null;
      const a = doc.createElement("a");
      a.setAttribute("href", href);
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
      a.textContent = found;
      return a;
    });
  }
}

/**
 * addTimecodes makes timecodes shorter than the episode into seek buttons
 * (ShownotesCleaner.addTimecodes). Short ones are HH:MM unless one of them
 * would be longer than the episode, then all are MM:SS. Without a duration
 * every timecode counts and short ones are HH:MM. A timecode inside a link
 * seeks, as on Android; the link is split around it.
 */
export function addTimecodes(root: Element, durationMs?: number): void {
  const doc = root.ownerDocument;
  const limit = durationMs ?? INT_MAX;
  const nodes = textNodes(root, false);
  const hours =
    limit === INT_MAX ||
    !nodes.some((n) => [...n.data.matchAll(TIMECODE)].some((m) => m[1] === undefined && timecodeMs(m, true) > limit));
  for (const node of nodes) {
    const buttons = replaceMatches(node, TIMECODE, (m) => {
      const ms = timecodeMs(m, hours);
      if (!(ms < limit)) return null;
      const b = doc.createElement("button");
      b.setAttribute("type", "button");
      b.setAttribute("data-timecode", String(ms));
      b.textContent = m[0];
      return b;
    });
    for (const b of buttons) {
      const a = linkAround(b);
      if (a) lift(b, a);
    }
  }
}

function timecodeMs(m: RegExpMatchArray, hours: boolean): number {
  const a = decimal(m[3]!);
  const b = decimal(m[4]!);
  if (m[1] !== undefined) return decimal(m[2]!) * 3_600_000 + a * 60_000 + b * 1000;
  return hours ? a * 3_600_000 + b * 60_000 : a * 60_000 + b * 1000;
}

const DIGIT = /\p{Nd}/u;

/** decimal reads Unicode decimal digits, as Java's Integer.parseInt does. */
function decimal(digits: string): number {
  let n = 0;
  for (const c of digits) {
    const cp = c.codePointAt(0)!;
    let zero = cp;
    if (cp >= 0x30 && cp <= 0x39) zero = 0x30;
    else while (DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
    // Decimal digits come in runs of ten, zero first, so adjacent runs stay aligned.
    n = n * 10 + ((cp - zero) % 10);
  }
  return n;
}

/** textNodes lists root's text in document order, leaving out text inside links if asked. */
function textNodes(root: Element, outsideLinks: boolean): Text[] {
  const out: Text[] = [];
  const stack: Node[] = [];
  for (let c = root.lastChild; c; c = c.previousSibling) stack.push(c);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.nodeType === TEXT) out.push(n as Text);
    else if (n.nodeType === ELEMENT && !(outsideLinks && (n as Element).localName === "a")) {
      for (let c = n.lastChild; c; c = c.previousSibling) stack.push(c);
    }
  }
  return out;
}

/** replaceMatches puts make's elements in place of pattern's matches in node; a null keeps the text. */
function replaceMatches(node: Text, pattern: RegExp, make: (m: RegExpMatchArray) => Element | null): Element[] {
  const parent = node.parentNode;
  const doc = node.ownerDocument;
  const text = node.data;
  const made: Element[] = [];
  if (!parent) return made;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const el = make(m);
    if (!el) continue;
    const at = m.index!;
    if (at > last) parent.insertBefore(doc.createTextNode(text.slice(last, at)), node);
    parent.insertBefore(el, node);
    made.push(el);
    last = at + m[0].length;
  }
  if (made.length === 0) return made;
  if (last < text.length) parent.insertBefore(doc.createTextNode(text.slice(last)), node);
  parent.removeChild(node);
  return made;
}

function linkAround(node: Node): Element | null {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (p.nodeType === ELEMENT && (p as Element).localName === "a") return p as Element;
  }
  return null;
}

/**
 * lift moves node out of the link around it. Every element from node's
 * parent up to the link is split in two; node goes between the halves,
 * wrapped in copies of the elements below the link, and empty halves go.
 */
function lift(node: Element, link: Element): void {
  let carried: Node = node;
  let tail: Element | null = null;
  let cur: Node = node;
  const split: Element[] = [];
  while (cur !== link) {
    const parent = cur.parentNode as Element;
    const rest = parent.cloneNode(false) as Element;
    if (tail) rest.appendChild(tail);
    while (cur.nextSibling) rest.appendChild(cur.nextSibling);
    if (cur === node) parent.removeChild(node);
    if (parent !== link) {
      const wrap = parent.cloneNode(false) as Element;
      wrap.appendChild(carried);
      carried = wrap;
    }
    tail = rest.hasChildNodes() ? rest : null;
    split.push(parent);
    cur = parent;
  }
  const after = link.nextSibling;
  link.parentNode!.insertBefore(carried, after);
  if (tail) link.parentNode!.insertBefore(tail, after);
  for (const el of split) if (!el.hasChildNodes()) el.parentNode?.removeChild(el);
}

/** verify throws unless root holds only allowed elements and attributes, with URLs that pass. */
function verify(root: Element, origin: string): void {
  const stack: Node[] = Array.from(root.childNodes);
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.nodeType === TEXT) continue;
    const el = n as Element;
    if (n.nodeType !== ELEMENT || el.namespaceURI !== HTML_NS || !tags.has(el.localName)) {
      throw new Error(`shownotes: the sanitizer left ${n.nodeName}`);
    }
    for (const attr of Array.from(el.attributes)) {
      if (attr.namespaceURI !== null || !attributeAllowed(el.localName, attr.name, attr.value, origin)) {
        throw new Error(`shownotes: the sanitizer left ${attr.name} on ${el.localName}`);
      }
    }
    stack.push(...Array.from(el.childNodes));
  }
}

function attributeAllowed(tag: string, name: string, value: string, origin: string): boolean {
  if (tag === "a") {
    if (name === "href") return safeURL(value, "link", origin) === value;
    if (name === "target") return value === "_blank";
    return name === "rel" && value === "noopener noreferrer";
  }
  if (tag === "img") {
    if (name === "src") return safeURL(value, "image", origin) === value;
    if (name === "referrerpolicy") return value === "no-referrer";
    return name === "alt" || name === "width" || name === "height";
  }
  return false;
}
