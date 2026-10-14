import path from "node:path";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import {
  PublicationError,
  type Snapshot,
  type PublicationRepository,
} from "./repository.ts";

export const SHARED = "社内共有";
export const REGISTRY = ".docs-id-registry.json";
export const ID = /^(?:[A-Za-z0-9_-]{12}|[A-Za-z0-9_-]{21})$/;
export type Registry = {
  version: 1;
  ids: Record<string, { path: string; retired: boolean }>;
  reviewedMoves?: Record<string, string[]>;
  reviewedChanges?: string[];
};
export type Note = { path: string; content: string; id?: string };
export type Reference = {
  target: string;
  wiki: boolean;
  image: boolean;
  start: number;
  end: number;
};
export type Issue = {
  code: string;
  path: string;
  target?: string;
  candidates?: string[];
};
const extensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".pdf",
  ".mp4",
  ".webm",
  ".mp3",
  ".wav",
  ".ogg",
  ".csv",
  ".txt",
  ".docx",
  ".xlsx",
  ".pptx",
  ".zip",
]);
export const shared = (p: string) => p.startsWith(`${SHARED}/`);
export function safePath(value: string, markdown = false): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new PublicationError(
      "INVALID_PATH",
      "パスのURLエンコードが不正です。",
    );
  }
  if (
    !decoded ||
    decoded !== decoded.trim() ||
    decoded.includes("%") ||
    decoded.includes("?") ||
    decoded.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(decoded) ||
    path.posix.isAbsolute(decoded) ||
    /^[A-Za-z]:/.test(decoded) ||
    decoded.split("/").some((p) => !p || p.startsWith(".") || p === "..")
  )
    throw new PublicationError(
      "INVALID_PATH",
      "安全なVault相対パスを指定してください。",
    );
  if (markdown && !decoded.endsWith(".md"))
    throw new PublicationError("INVALID_PATH", ".mdノートだけを指定できます。");
  return decoded;
}
export function frontmatter(content: string) {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    content,
  );
  if (!match)
    return {
      id: undefined,
      body: content,
      offset: 0,
      match,
      document: undefined,
    };
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length)
    throw new PublicationError(
      "INVALID_FRONTMATTER",
      "Frontmatterが不正です。",
    );
  const meta: unknown = document.toJS({ maxAliasCount: 0 });
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    throw new PublicationError(
      "INVALID_FRONTMATTER",
      "Frontmatterはオブジェクトで指定してください。",
    );
  const { doc_id: id, title } = meta as { doc_id?: unknown; title?: unknown };
  if (id !== undefined && (typeof id !== "string" || !ID.test(id)))
    throw new PublicationError("INVALID_ID", "doc_idが不正です。");
  if (title !== undefined && (typeof title !== "string" || !title.trim()))
    throw new PublicationError("INVALID_FRONTMATTER", "titleが不正です。");
  return {
    id: id as string | undefined,
    body: content.slice(match[0].length),
    offset: match[0].length,
    match,
    document,
  };
}
export function withId(content: string, id: string) {
  const fm = frontmatter(content);
  if (fm.id === id) return content;
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  if (!fm.match || !fm.document)
    return `---${newline}doc_id: ${id}${newline}---${newline}${newline}${content}`;
  fm.document.set("doc_id", id);
  const bom = content.startsWith("\uFEFF") ? "\uFEFF" : "";
  return `${bom}---${newline}${fm.document.toString().replace(/\n/g, newline)}---${newline}${fm.body}`;
}
export function registry(content?: string): Registry {
  if (content === undefined) return { version: 1, ids: {} };
  let value: Registry;
  try {
    value = JSON.parse(content);
  } catch {
    throw new PublicationError("INVALID_REGISTRY", "台帳JSONが不正です。");
  }
  if (
    !value ||
    value.version !== 1 ||
    !value.ids ||
    typeof value.ids !== "object" ||
    Array.isArray(value.ids)
  )
    throw new PublicationError("INVALID_REGISTRY", "台帳の形式が不正です。");
  const folded = new Set<string>();
  for (const [id, e] of Object.entries(value.ids)) {
    if (
      !ID.test(id) ||
      folded.has(id.toLowerCase()) ||
      !e ||
      typeof e.path !== "string" ||
      !shared(safePath(e.path, true)) ||
      typeof e.retired !== "boolean"
    )
      throw new PublicationError(
        "INVALID_REGISTRY",
        "台帳の項目またはIDが不正です。",
      );
    folded.add(id.toLowerCase());
  }
  if (
    value.reviewedChanges !== undefined &&
    (!Array.isArray(value.reviewedChanges) ||
      value.reviewedChanges.some(
        (k) => typeof k !== "string" || !/^[a-f0-9]{64}$/.test(k),
      ))
  )
    throw new PublicationError("INVALID_REGISTRY", "変更確認履歴が不正です。");
  if (
    value.reviewedMoves !== undefined &&
    (!value.reviewedMoves ||
      typeof value.reviewedMoves !== "object" ||
      Array.isArray(value.reviewedMoves) ||
      Object.entries(value.reviewedMoves).some(
        ([id, moves]) =>
          !value.ids[id] ||
          !Array.isArray(moves) ||
          moves.some((m) => typeof m !== "string"),
      ))
  )
    throw new PublicationError("INVALID_REGISTRY", "移動確認履歴が不正です。");
  return value;
}
export function identityKey(
  before: Record<string, string>,
  after: Record<string, string>,
) {
  const canonical = (docs: Record<string, string>) =>
    Object.entries(docs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([canonical(before), canonical(after)]))
    .digest("hex");
}
export function identities(notes: Note[], ledger?: Registry, requireId = true) {
  const docs: Record<string, string> = {};
  const folded = new Set<string>();
  for (const note of notes) {
    if (!note.id) {
      if (requireId)
        throw new PublicationError(
          "MISSING_ID",
          `共有ノートにIDがありません: ${note.path}`,
        );
      else continue;
    }
    if (folded.has(note.id.toLowerCase()))
      throw new PublicationError(
        "DUPLICATE_ID",
        "共有ノートのIDが重複しています。",
      );
    folded.add(note.id.toLowerCase());
    docs[note.id] = note.path;
    if (ledger) {
      const entry = ledger.ids[note.id];
      if (!entry || entry.retired)
        throw new PublicationError(
          "RETIRED_OR_UNREGISTERED_ID",
          "廃止IDまたは台帳未登録のIDです。",
        );
      if (
        Object.entries(ledger.ids).some(
          ([id, e]) => id !== note.id && e.path === note.path,
        )
      )
        throw new PublicationError(
          "ID_CHANGED",
          "初回パスに別IDを登録できません。",
        );
    }
  }
  return docs;
}
export async function loadNotes(
  repo: PublicationRepository,
  snapshot: Snapshot,
  vault: string,
  onlyShared = true,
): Promise<Note[]> {
  const notes: Note[] = [];
  const prefix = `${vault}/`;
  for (const [p, e] of snapshot.entries) {
    if (!p.startsWith(prefix)) continue;
    const relative = p.slice(prefix.length);
    if (onlyShared && !shared(relative)) continue;
    // Shared symlinks are rejected even if not referenced, matching officeSystem.walk.
    if (
      onlyShared &&
      e.type !== "tree" &&
      !["100644", "100755"].includes(e.mode)
    )
      throw new PublicationError(
        "UNSAFE_FILE",
        "共有範囲に通常ファイル以外があります。",
      );
    if (
      !relative.endsWith(".md") ||
      relative.split("/").some((part) => part.startsWith("."))
    )
      continue;
    safePath(relative, true);
    const content = await repo.text(snapshot, p);
    notes.push({ path: relative, content, id: frontmatter(content).id });
  }
  return notes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
// Only AST text nodes are scanned for Wiki syntax; code/inlineCode are never visited.
export function references(content: string): Reference[] {
  const fm = frontmatter(content);
  const tree = unified().use(remarkParse).use(remarkGfm).parse(fm.body);
  const refs: Reference[] = [];
  type Node = {
    type: string;
    url?: string;
    value?: string;
    identifier?: string;
    children?: Node[];
    position?: { start: { offset?: number }; end: { offset?: number } };
  };
  const usedDefinitions = new Set<string>();
  const collectUsage = (node: Node) => {
    if (
      ["linkReference", "imageReference"].includes(node.type) &&
      node.identifier
    )
      usedDefinitions.add(node.identifier.toLowerCase());
    node.children?.forEach(collectUsage);
  };
  collectUsage(tree as Node);
  const definitions = new Set<string>();
  const walk = (node: Node) => {
    if (node.type === "html")
      throw new PublicationError("UNSAFE_CONTENT", "生HTMLは公開できません。");
    if (["code", "inlineCode"].includes(node.type)) return;
    const start = (node.position?.start.offset ?? 0) + fm.offset;
    const end = (node.position?.end.offset ?? 0) + fm.offset;
    if (node.type === "definition") {
      const key = node.identifier?.toLowerCase() ?? "";
      if (definitions.has(key))
        throw new PublicationError(
          "AMBIGUOUS_REFERENCE",
          "リンク定義が重複しています。",
        );
      definitions.add(key);
    }
    if (
      ["link", "image", "definition"].includes(node.type) &&
      node.url &&
      (node.type !== "definition" ||
        usedDefinitions.has(node.identifier!.toLowerCase()))
    ) {
      const raw = content.slice(start, end);
      const delimiter =
        node.type === "definition" ? raw.indexOf("]:") : raw.lastIndexOf("](");
      const from = delimiter < 0 ? 0 : delimiter + 2;
      const at = raw.indexOf(node.url, from);
      if (at < from)
        throw new PublicationError(
          "UNSUPPORTED_REFERENCE",
          "リンクの原文位置を安全に特定できません。",
        );
      refs.push({
        target: node.url,
        wiki: false,
        image: node.type === "image",
        start: start + at,
        end: start + at + node.url.length,
      });
    }
    if (node.type === "text" && node.value) {
      const raw = content.slice(start, end);
      if (/(?:!?)\[[^\]\n]+\]\[(?:[^\]\n]*)\]/.test(node.value))
        throw new PublicationError(
          "MISSING_REFERENCE",
          "未解決のリンク定義があります。",
        );
      const matches = [...node.value.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)];
      const rawMatches = [...raw.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)];
      if (
        matches.length !== rawMatches.length ||
        matches.some((m, i) => m[0] !== rawMatches[i]?.[0])
      )
        throw new PublicationError(
          "UNSUPPORTED_REFERENCE",
          "エスケープされたWiki参照を安全に変換できません。コード記法または通常リンクを使ってください。",
        );
      for (const match of rawMatches) {
        const target = match[2]!.split("|")[0]!;
        refs.push({
          target,
          wiki: true,
          image: !!match[1],
          start: start + match.index! + match[1]!.length + 2,
          end: start + match.index! + match[1]!.length + 2 + target.length,
        });
      }
    }
    node.children?.forEach(walk);
  };
  walk(tree as Node);
  // Unresolved reference syntax is left as text by remark; reject explicit missing definitions.
  const definitionsTree = new Set<string>();
  const collect = (node: Node) => {
    if (node.type === "definition")
      definitionsTree.add(node.identifier!.toLowerCase());
    node.children?.forEach(collect);
  };
  collect(tree as Node);
  const check = (node: Node) => {
    if (
      ["linkReference", "imageReference"].includes(node.type) &&
      !definitionsTree.has(node.identifier!.toLowerCase())
    )
      throw new PublicationError(
        "MISSING_REFERENCE",
        "リンク定義がありません。",
      );
    if (node.type === "imageReference") {
      // Image definitions must receive the same external-image policy.
      const mark = (n: Node) => {
        if (
          n.type === "definition" &&
          n.identifier?.toLowerCase() === node.identifier!.toLowerCase()
        )
          refs
            .filter((r) => r.target === n.url)
            .forEach((r) => (r.image = true));
        n.children?.forEach(mark);
      };
      mark(tree as Node);
    }
    node.children?.forEach(check);
  };
  check(tree as Node);
  return refs;
}
export function resolve(
  ref: Reference,
  from: string,
  paths: string[],
): { path?: string; fragment: string } {
  const target = ref.target;
  if (/^(https?:\/\/|mailto:)/i.test(target)) {
    if (ref.image && /^https?:/i.test(target))
      throw new PublicationError(
        "UNSAFE_CONTENT",
        "外部画像は公開できません。",
      );
    return { fragment: "" };
  }
  if (target.startsWith("#")) {
    let fragment: string;
    try {
      fragment = decodeURIComponent(target);
    } catch {
      throw new PublicationError(
        "INVALID_REFERENCE",
        "参照のエンコードが不正です。",
      );
    }
    if (fragment.startsWith("#^"))
      throw new PublicationError(
        "UNSUPPORTED_REFERENCE",
        "ブロックID参照は公開できません。",
      );
    return { fragment: target };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//"))
    throw new PublicationError("INVALID_REFERENCE", "禁止されたURLです。");
  const hash = target.indexOf("#");
  const raw = hash < 0 ? target : target.slice(0, hash);
  const fragment = hash < 0 ? "" : target.slice(hash);
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
    decodeURIComponent(fragment);
  } catch {
    throw new PublicationError(
      "INVALID_REFERENCE",
      "参照のエンコードが不正です。",
    );
  }
  if (
    !decoded ||
    decoded.includes("%") ||
    decoded.includes("?") ||
    decoded.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(decoded) ||
    path.posix.isAbsolute(decoded) ||
    decoded
      .split("/")
      .some((p) => p.startsWith(".") && p !== "." && p !== "..") ||
    (/%2e/i.test(raw) && decoded.split("/").includes("..")) ||
    (ref.wiki && decoded.split("/").includes(".."))
  )
    throw new PublicationError("INVALID_REFERENCE", "不正な参照パスです。");
  if (decodeURIComponent(fragment).startsWith("#^"))
    throw new PublicationError(
      "UNSUPPORTED_REFERENCE",
      "ブロックID参照は公開できません。",
    );
  const normalized = decoded.replace(/^\.\//, "");
  const variants = [
    normalized,
    ...(!path.posix.extname(normalized) ? [normalized + ".md"] : []),
  ];
  const candidates = [
    ...new Set(
      ref.wiki
        ? variants.flatMap((v) =>
            paths.filter(
              (p) => p === v || p === `${SHARED}/${v}` || p.endsWith("/" + v),
            ),
          )
        : variants
            .map((v) =>
              path.posix.normalize(
                path.posix.join(path.posix.dirname(from), v),
              ),
            )
            .filter((p) => paths.includes(p)),
    ),
  ];
  if (candidates.length !== 1)
    throw new PublicationError(
      candidates.length ? "AMBIGUOUS_REFERENCE" : "MISSING_REFERENCE",
      "参照先が不足または曖昧です。",
      { candidates },
    );
  const selected = candidates[0]!;
  if (selected.split("/").some((part) => part.startsWith(".")))
    throw new PublicationError(
      "UNSAFE_FILE",
      "隠しフォルダ・ファイルは公開参照に使用できません。",
    );
  if (selected.startsWith("../"))
    throw new PublicationError("INVALID_REFERENCE", "Vault外への参照です。");
  if (
    !selected.endsWith(".md") &&
    !extensions.has(path.posix.extname(selected).toLowerCase())
  )
    throw new PublicationError(
      "UNSAFE_ATTACHMENT",
      "添付形式が公開対象外です。",
    );
  return { path: selected, fragment };
}
export function rewrite(
  content: string,
  edits: { start: number; end: number; value: string }[],
) {
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    content =
      content.slice(0, edit.start) + edit.value + content.slice(edit.end);
  return content;
}
export async function validateGraph(
  repo: PublicationRepository,
  snapshot: Snapshot,
  vault: string,
  notes: Note[],
  paths: string[],
): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const note of notes) {
    try {
      for (const ref of references(note.content)) {
        try {
          if (!ref.wiki && shared(note.path)) {
            const raw = ref.target.split("#")[0]!;
            if (
              !/^(https?:|mailto:|#)/i.test(ref.target) &&
              !path.posix
                .normalize(
                  path.posix.join(
                    path.posix.dirname(note.path),
                    decodeURIComponent(raw),
                  ),
                )
                .startsWith(`${SHARED}/`)
            )
              throw new PublicationError(
                "NON_SHARED_REFERENCE",
                "共有範囲外です。",
              );
          }
          const selected = resolve(ref, note.path, paths);
          if (selected.path && !shared(selected.path))
            throw new PublicationError(
              "NON_SHARED_REFERENCE",
              "共有範囲外です。",
            );
          if (
            selected.path &&
            snapshot.entries.has(`${vault}/${selected.path}`)
          ) {
            const entry = repo.regular(snapshot, `${vault}/${selected.path}`);
            if ((entry.size ?? 0) > 25 * 1024 * 1024)
              throw new PublicationError(
                "UNSAFE_ATTACHMENT",
                "添付が25MiBを超えています。",
              );
          }
        } catch (e) {
          if (!(e instanceof PublicationError)) throw e;
          issues.push({
            code: e.code,
            path: note.path,
            target: ref.target,
            ...(e.details?.candidates
              ? { candidates: e.details.candidates }
              : {}),
          });
        }
      }
    } catch (e) {
      if (!(e instanceof PublicationError)) throw e;
      issues.push({ code: e.code, path: note.path });
    }
  }
  return issues;
}
