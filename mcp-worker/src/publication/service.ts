import path from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import {
  PathValidationError,
  validateVaultName,
} from "../../../shared/src/paths.ts";
import { ok, fail, type ToolResult } from "../../../shared/src/response.ts";
import type { GitHubRepoConfig } from "../github/client.ts";
import {
  PublicationError,
  PublicationRepository,
  type Change,
  type Snapshot,
} from "./repository.ts";
import {
  ID,
  REGISTRY,
  SHARED,
  frontmatter,
  identities,
  identityKey,
  loadNotes,
  references,
  registry,
  resolve,
  rewrite,
  safePath,
  shared,
  validateGraph,
  withId,
  type Issue,
  type Note,
} from "./content.ts";
import { verifyHistory, validateTransition } from "./history.ts";
import {
  readState,
  observeSync,
  documentFingerprint,
  deployedNotes,
} from "./state.ts";

export type PrepareInput = {
  vault: string;
  path: string;
  destinationPath?: string;
  expectedSha: string;
  mode: "move" | "copy";
};
export type StopInput = {
  vault: string;
  path: string;
  destinationPath: string;
  expectedSha: string;
};
type Input = PrepareInput | StopInput;
type Token = {
  version: 1;
  repository: string;
  branch: string;
  action: "publish" | "unpublish";
  input: Input;
  head: string;
  id: string;
  digest: string;
  expires: number;
};
export type PublicationOptions = {
  source: GitHubRepoConfig;
  planSecret?: string;
  office?: GitHubRepoConfig;
};
type Attachment = {
  source: string;
  destination: string;
  sha: string;
  approvalRequired: boolean;
};
type BuiltPlan = {
  snapshot: Snapshot;
  changes: Change[];
  id: string;
  summary: Record<string, unknown>;
  issues: Issue[];
  attachments: Attachment[];
  stateHead?: string;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const audience =
  "社内共有に置くと、Cloudflare Accessで認証した @zuikaku.biz の全メールアドレスが閲覧できます。";
export function nextSync(now = new Date()) {
  const next = new Date(now);
  next.setUTCMinutes(17, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  return new Date(next.getTime() + 9 * 3600000)
    .toISOString()
    .replace("Z", "+09:00");
}
export class PublicationService {
  constructor(readonly options: PublicationOptions) {}
  private repo() {
    return new PublicationRepository(this.options.source);
  }
  private async key() {
    if (!this.options.planSecret || this.options.planSecret.length < 32)
      throw new PublicationError(
        "PLAN_SECRET_NOT_CONFIGURED",
        "PUBLICATION_PLAN_SECRET（32文字以上）の設定が必要です。",
      );
    return crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.options.planSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
  }
  private async sign(value: Token) {
    const payload = Buffer.from(JSON.stringify(value)).toString("base64url");
    const signature = await crypto.subtle.sign(
      "HMAC",
      await this.key(),
      new TextEncoder().encode(payload),
    );
    return `${payload}.${Buffer.from(signature).toString("base64url")}`;
  }
  private async verify(token: string): Promise<Token> {
    if (token.length > 16000 || token.split(".").length !== 2)
      throw new PublicationError("INVALID_PLAN", "確認トークンが不正です。");
    const [payload, signature] = token.split(".") as [string, string];
    let value: Token;
    try {
      if (
        !(await crypto.subtle.verify(
          "HMAC",
          await this.key(),
          Buffer.from(signature, "base64url"),
          new TextEncoder().encode(payload),
        ))
      )
        throw new Error();
      value = JSON.parse(Buffer.from(payload, "base64url").toString());
    } catch (e) {
      if (e instanceof PublicationError) throw e;
      throw new PublicationError(
        "INVALID_PLAN",
        "確認トークンの署名が不正です。",
      );
    }
    if (
      value.version !== 1 ||
      value.repository !==
        `${this.options.source.owner}/${this.options.source.repo}` ||
      value.branch !== this.options.source.branch ||
      !ID.test(value.id)
    )
      throw new PublicationError(
        "INVALID_PLAN",
        "別リポジトリ・ブランチの予定は適用できません。",
      );
    return value;
  }
  private async result(fn: () => Promise<ToolResult>): Promise<ToolResult> {
    try {
      return await fn();
    } catch (e) {
      return fail(
        e instanceof PublicationError || e instanceof PathValidationError
          ? e.code
          : "PUBLICATION_ERROR",
        e instanceof PublicationError || e instanceof PathValidationError
          ? e.message
          : "公開処理を安全に確認できません。変更結果を確認してください。",
      );
    }
  }
  async prepare(input: PrepareInput): Promise<ToolResult> {
    return this.prepareAction("publish", input);
  }
  async unpublish(
    input: StopInput | { planToken: string; confirm: boolean },
  ): Promise<ToolResult> {
    if ("planToken" in input)
      return this.apply(input.planToken, input.confirm, [], "unpublish");
    return this.prepareAction("unpublish", input);
  }
  private prepareAction(
    action: Token["action"],
    input: Input,
  ): Promise<ToolResult> {
    return this.result(async () => {
      const repo = this.repo();
      await repo.assertPrivate();
      const snapshot = await repo.snapshot();
      const built = await this.build(repo, snapshot, action, input);
      const token = built.issues.length
        ? null
        : await this.sign({
            version: 1,
            repository: `${repo.config.owner}/${repo.config.repo}`,
            branch: repo.config.branch,
            action,
            input,
            head: snapshot.head,
            id: built.id,
            digest: hash(JSON.stringify(built.summary)),
            expires: Date.now() + 30 * 60000,
          });
      return ok({
        ...built.summary,
        planToken: token,
        expiresAt: token
          ? new Date(Date.now() + 30 * 60000).toISOString()
          : null,
        ready: !built.issues.length,
      });
    });
  }
  async publish(input: {
    planToken: string;
    confirm: boolean;
    approvedAttachments?: string[];
  }) {
    return this.apply(
      input.planToken,
      input.confirm,
      input.approvedAttachments ?? [],
      "publish",
    );
  }
  private apply(
    planToken: string,
    confirm: boolean,
    approved: string[],
    expectedAction: Token["action"],
  ): Promise<ToolResult> {
    return this.result(async () => {
      if (confirm !== true)
        throw new PublicationError(
          "CONFIRMATION_REQUIRED",
          "公開範囲と変更予定の確認が必要です。",
        );
      const token = await this.verify(planToken);
      if (token.action !== expectedAction)
        throw new PublicationError(
          "INVALID_PLAN",
          "操作の種類が一致しません。",
        );
      const marker = hash(planToken);
      const repo = this.repo();
      await repo.assertPrivate();
      const head = await repo.head();
      // Search exact operation before expiry/conflict checks: retries of completed work are read-only.
      const completed = (await repo.commits(head)).find((c) =>
        c.commit.message
          .split("\n")
          .includes(`Publication-Operation: ${marker}`),
      );
      if (completed)
        return this.success(token.id, completed.sha, true, token.action);
      if (Date.now() > token.expires)
        throw new PublicationError(
          "PLAN_EXPIRED",
          "確認予定の有効期限が切れました。再準備してください。",
        );
      if (head !== token.head)
        throw new PublicationError(
          "CONFLICT",
          "原本のブランチ先頭が変更されました。再準備してください。",
        );
      const snapshot = await repo.snapshot(head);
      const built = await this.build(
        repo,
        snapshot,
        token.action,
        token.input,
        token.id,
      );
      if (
        built.issues.length ||
        hash(JSON.stringify(built.summary)) !== token.digest
      )
        throw new PublicationError(
          "CONFLICT",
          "ノート・添付・台帳・同期状態または参照が変更されました。再準備してください。",
        );
      const required = built.attachments
        .filter((a) => a.approvalRequired)
        .map((a) => a.source);
      if (
        new Set(approved).size !== approved.length ||
        approved.some((p) => !required.includes(p)) ||
        required.some((p) => !approved.includes(p))
      )
        throw new PublicationError(
          "ATTACHMENT_APPROVAL_REQUIRED",
          "予定された非共有添付をファイルごとに承認してください。",
        );
      const commit = await repo.atomic(snapshot, built.changes, marker);
      return this.success(built.id, commit, false, token.action);
    });
  }
  private success(
    id: string,
    commit: string,
    replay: boolean,
    action: Token["action"],
  ) {
    return ok({
      doc_id: id,
      url: `https://work.zuikaku.biz/docs/${id}`,
      sourceCommit: commit,
      replayed: replay,
      registration:
        action === "publish" ? "原本登録成功" : "原本の公開停止登録成功",
      nextSyncAt: nextSync(),
      synchronization: {
        started: false,
        message: "毎時17分の同期を待ちます。GitHub側で遅延する場合があります。",
      },
      message:
        action === "publish"
          ? "原本へ登録しました。本番への反映は同期成功後です。"
          : "同期が成功するまで本番に前回の資料が残ります。同じ廃止IDでの再公開はできません。",
    });
  }
  private async build(
    repo: PublicationRepository,
    snapshot: Snapshot,
    action: Token["action"],
    raw: Input,
    fixedId?: string,
  ): Promise<BuiltPlan> {
    const vault = validateVaultName(raw.vault);
    if (vault !== "main")
      throw new PublicationError(
        "INVALID_VAULT",
        "社内サイトの公開対象Vaultはmainだけです。",
      );
    const source = safePath(raw.path, true);
    const mode = action === "unpublish" ? "move" : (raw as PrepareInput).mode;
    if (!["move", "copy"].includes(mode))
      throw new PublicationError("INVALID_INPUT", "modeはmoveまたはcopyです。");
    const destination = safePath(
      raw.destinationPath ??
        (shared(source) && mode === "move"
          ? source
          : `${SHARED}/${path.posix.basename(source)}`),
      true,
    );
    if (
      action === "publish"
        ? !shared(destination)
        : !shared(source) || shared(destination)
    )
      throw new PublicationError(
        "INVALID_PATH",
        "公開は共有配下へ、公開停止は共有配下から非共有フォルダへ移動してください。",
      );
    if (snapshot.entries.get(vault)?.type !== "tree")
      throw new PublicationError("INVALID_VAULT", "Vaultがありません。");
    const entry = repo.regular(snapshot, `${vault}/${source}`);
    if (!raw.expectedSha || entry.sha !== raw.expectedSha)
      throw new PublicationError("CONFLICT", "ノートSHAが変更されました。");
    if (source === destination && mode === "copy")
      throw new PublicationError(
        "INVALID_PATH",
        "コピー先は別パスにしてください。",
      );
    repo.destination(
      snapshot,
      `${vault}/${destination}`,
      source === destination,
    );
    const original = await repo.text(snapshot, `${vault}/${source}`);
    const originalId = frontmatter(original).id;
    const ledgerPath = `${vault}/${REGISTRY}`;
    const ledger = registry(
      snapshot.entries.has(ledgerPath)
        ? await repo.text(snapshot, ledgerPath)
        : undefined,
    );
    const originalLedger = structuredClone(ledger);
    const retired = await verifyHistory(repo, snapshot, vault, ledger);
    const stateEvidence = await readState(this.options.office);
    const state = stateEvidence.state;
    const currentNotes = await loadNotes(repo, snapshot, vault);
    const before = identities(currentNotes, undefined, false);
    if (
      action === "unpublish" &&
      (!originalId ||
        !ledger.ids[originalId] ||
        ledger.ids[originalId]!.retired)
    )
      throw new PublicationError(
        "UNREGISTERED",
        "登録済みの公開文書を指定してください。",
      );
    if (
      action === "publish" &&
      mode === "move" &&
      originalId &&
      !shared(source)
    )
      throw new PublicationError(
        "EXISTING_PRIVATE_ID",
        "非共有ノートにIDがあります。廃止IDの復活はできません。別文書としてcopyで登録してください。",
      );
    let id =
      action === "unpublish" || (mode === "move" && originalId)
        ? originalId!
        : fixedId;
    if (!id)
      do {
        id = nanoid(12);
      } while (
        Object.keys(ledger.ids).some(
          (existing) => existing.toLowerCase() === id!.toLowerCase(),
        ) ||
        Object.keys(before).some(
          (existing) => existing.toLowerCase() === id!.toLowerCase(),
        ) ||
        [...retired].some((old) => old.toLowerCase() === id!.toLowerCase())
      );
    if (fixedId && fixedId !== id)
      throw new PublicationError("INVALID_PLAN", "予定IDが一致しません。");
    if (
      action === "publish" &&
      ([...retired].some((old) => old.toLowerCase() === id.toLowerCase()) ||
        state?.retiredIds.some(
          (old) => old.toLowerCase() === id.toLowerCase(),
        ) ||
        ledger.ids[id]?.retired)
    )
      throw new PublicationError("RETIRED_ID", "廃止IDは再利用できません。");
    if (
      action === "publish" &&
      Object.keys(ledger.ids).some(
        (existing) =>
          existing !== id && existing.toLowerCase() === id.toLowerCase(),
      )
    )
      throw new PublicationError(
        "DUPLICATE_ID",
        "大文字小文字だけ異なるIDがあります。",
      );
    if (action === "publish" && before[id] && before[id] !== source)
      throw new PublicationError(
        "DUPLICATE_ID",
        "別の共有文書が同じIDを使用しています。",
      );
    const changes: Change[] = [];
    const attachments: Attachment[] = [];
    const issues: Issue[] = [];
    const warnings: Issue[] = [];
    const edits: { start: number; end: number; value: string }[] = [];
    const allPaths = [...snapshot.entries.keys()]
      .filter(
        (p) =>
          p.startsWith(`${vault}/`) && snapshot.entries.get(p)?.type !== "tree",
      )
      .map((p) => p.slice(vault.length + 1));
    {
      try {
        for (const ref of references(original)) {
          try {
            let resolved;
            try {
              resolved = resolve(
                ref,
                source,
                shared(source) ? allPaths.filter(shared) : allPaths,
              );
            } catch (e) {
              if (
                !(e instanceof PublicationError) ||
                e.code !== "MISSING_REFERENCE"
              )
                throw e;
              resolved = resolve(ref, source, allPaths);
            }
            if (!resolved.path) continue;
            let target = resolved.path;
            const targetEntry = repo.regular(snapshot, `${vault}/${target}`);
            if (target.endsWith(".md")) {
              if (target === source) target = destination;
              else if (action === "publish" && !shared(target))
                throw new PublicationError(
                  "NON_SHARED_REFERENCE",
                  "非共有ノートは追加公開しません。",
                );
            } else if (action === "publish") {
              if ((targetEntry.size ?? 0) > 25 * 1024 * 1024)
                throw new PublicationError(
                  "UNSAFE_ATTACHMENT",
                  "添付が25MiBを超えています。",
                );
              const attachDestination = shared(target)
                ? target
                : `${SHARED}/${path.posix.basename(target)}`;
              if (!shared(target)) {
                repo.destination(snapshot, `${vault}/${attachDestination}`);
                if (
                  attachments.some(
                    (a) =>
                      a.destination === attachDestination &&
                      a.source !== target,
                  )
                )
                  throw new PublicationError(
                    "ALREADY_EXISTS",
                    "添付の配置先が重複します。",
                  );
              }
              if (!attachments.some((a) => a.source === target))
                attachments.push({
                  source: target,
                  destination: attachDestination,
                  sha: targetEntry.sha,
                  approvalRequired: !shared(target),
                });
              target = attachDestination;
            }
            const next =
              (ref.wiki
                ? target
                : path.posix.relative(path.posix.dirname(destination), target)
              )
                .split("/")
                .map((segment) => encodeURIComponent(segment))
                .join("/") + resolved.fragment;
            if (next !== ref.target)
              edits.push({ start: ref.start, end: ref.end, value: next });
          } catch (e) {
            if (!(e instanceof PublicationError)) throw e;
            (action === "publish" ? issues : warnings).push({
              code: e.code,
              path: source,
              target: ref.target,
              ...(e.details?.candidates
                ? { candidates: e.details.candidates }
                : {}),
            });
          }
        }
      } catch (e) {
        if (!(e instanceof PublicationError)) throw e;
        (action === "publish" ? issues : warnings).push({
          code: e.code,
          path: source,
        });
      }
    }
    // Copies preserve private originals and incoming links. Moves must not break any Vault note.
    if (mode === "move" && source !== destination) {
      for (const note of await loadNotes(
        repo,
        snapshot,
        vault,
        action === "unpublish",
      )) {
        if (note.path === source) continue;
        try {
          for (const ref of references(note.content)) {
            let target: string | undefined;
            try {
              target = resolve(ref, note.path, allPaths).path;
            } catch (e) {
              if (
                e instanceof PublicationError &&
                e.details?.candidates?.includes(source)
              ) {
                issues.push({
                  code: "AMBIGUOUS_INCOMING_LINK",
                  path: note.path,
                  target: ref.target,
                  candidates: e.details.candidates,
                });
              }
              continue;
            }
            if (target !== source) continue;
            try {
              const afterPaths = allPaths
                .filter((p) => p !== source)
                .concat(destination);
              if (
                resolve(ref, note.path, afterPaths).path !== destination ||
                (action === "unpublish" && shared(note.path))
              )
                throw new Error();
            } catch {
              issues.push({
                code: "BROKEN_INCOMING_LINK",
                path: note.path,
                target: ref.target,
              });
            }
          }
        } catch (e) {
          if (!(e instanceof PublicationError)) throw e;
          issues.push({ code: "REFERENCE_SCAN_FAILED", path: note.path });
        }
      }
    }
    const content =
      action === "publish"
        ? withId(rewrite(original, edits), id)
        : rewrite(original, edits);
    const afterNotes = currentNotes.filter(
      (n) => !(mode === "move" && n.path === source),
    );
    if (action === "publish")
      afterNotes.push({ path: destination, content, id });
    if (action === "publish") {
      if (!ledger.ids[id]) {
        if (Object.values(ledger.ids).some((e) => e.path === destination))
          throw new PublicationError(
            "ID_CHANGED",
            "発行済みパスには新しいIDを登録できません。",
          );
        ledger.ids[id] = { path: destination, retired: false };
      }
      for (const from of new Set([
        ledger.ids[id]!.path,
        before[id],
        state?.docs[id],
      ])) {
        if (from && from !== destination) {
          ledger.reviewedMoves ??= {};
          ledger.reviewedMoves[id] ??= [];
          const transition = `${from} -> ${destination}`;
          if (!ledger.reviewedMoves[id]!.includes(transition))
            ledger.reviewedMoves[id]!.push(transition);
        }
      }
    } else ledger.ids[id]!.retired = true;
    const after = identities(afterNotes, ledger);
    const addReview = (old: Record<string, string>) => {
      if (
        Object.keys(old).some((key) => !after[key]) &&
        Object.keys(after).some((key) => !old[key])
      ) {
        ledger.reviewedChanges ??= [];
        const key = identityKey(old, after);
        if (!ledger.reviewedChanges.includes(key))
          ledger.reviewedChanges.push(key);
      }
    };
    addReview(before);
    if (state) addReview(state.docs);
    validateTransition(before, after, ledger, new Set(retired), true);
    if (state)
      validateTransition(
        state.docs,
        after,
        ledger,
        new Set(state.retiredIds),
        true,
      );
    for (const [key, e] of Object.entries(ledger.ids))
      if (!e.retired && !after[key])
        throw new PublicationError(
          "STALE_REGISTRY",
          "共有文書が不在の未廃止IDがあります。台帳の整合性を確認してください。",
        );
    const projectedPaths = allPaths
      .filter((p) => !(mode === "move" && p === source))
      .concat(
        destination,
        attachments.map((a) => a.destination),
      );
    issues.push(
      ...(await validateGraph(
        repo,
        snapshot,
        vault,
        afterNotes,
        projectedPaths.filter(shared),
      )),
    );
    changes.push({
      path: `${vault}/${destination}`,
      content,
      mode: entry.mode,
    });
    if (mode === "move" && source !== destination)
      changes.push({ path: `${vault}/${source}`, sha: null, mode: entry.mode });
    for (const a of attachments.filter((a) => a.approvalRequired))
      changes.push({ path: `${vault}/${a.destination}`, sha: a.sha });
    changes.push({
      path: ledgerPath,
      content: JSON.stringify(ledger, null, 2) + "\n",
    });
    const summary = {
      action,
      vault,
      sourcePath: source,
      destinationPath: destination,
      mode,
      doc_id: id,
      documents: afterNotes
        .filter((n) => n.path === destination)
        .map((n) => ({ path: n.path, doc_id: n.id })),
      attachments,
      linkEdits: edits.map((e) => ({
        start: e.start,
        end: e.end,
        replacement: e.value,
      })),
      issues,
      warnings,
      registryChanges: {
        register: Object.keys(ledger.ids).filter(
          (key) => !originalLedger.ids[key],
        ),
        retire: Object.keys(ledger.ids).filter(
          (key) =>
            ledger.ids[key]!.retired && !originalLedger.ids[key]?.retired,
        ),
        reviewedMoves: Object.fromEntries(
          Object.entries(ledger.reviewedMoves ?? {})
            .map(
              ([key, moves]) =>
                [
                  key,
                  moves.filter(
                    (move) =>
                      !originalLedger.reviewedMoves?.[key]?.includes(move),
                  ),
                ] as const,
            )
            .filter(([, moves]) => moves.length),
        ),
        reviewedChanges: (ledger.reviewedChanges ?? []).filter(
          (key) => !originalLedger.reviewedChanges?.includes(key),
        ),
      },
      audience: action === "publish" ? audience : null,
      changes: changes.map((c) => ({
        path: c.path,
        operation:
          c.sha === null
            ? "delete"
            : c.content !== undefined
              ? "write"
              : "copy",
        sha: c.sha ?? null,
      })),
      revisions: {
        head: snapshot.head,
        sourceSha: entry.sha,
        registrySha: snapshot.entries.get(ledgerPath)?.sha ?? null,
        destinationSha:
          snapshot.entries.get(`${vault}/${destination}`)?.sha ?? null,
        deployStateHead: stateEvidence.head ?? null,
      },
      stateConstraint: stateEvidence.unavailable ?? null,
      message:
        action === "unpublish"
          ? "同期成功まで本番に前回の資料が残ります。廃止IDは再利用できません。"
          : audience,
    };
    return {
      snapshot,
      changes,
      id,
      summary,
      issues,
      attachments,
      stateHead: stateEvidence.head,
    };
  }
  async status(input: {
    vault: string;
    path?: string;
    doc_id?: string;
  }): Promise<ToolResult> {
    const result = await this.result(async () => {
      const vault = validateVaultName(input.vault);
      if (vault !== "main")
        throw new PublicationError(
          "INVALID_VAULT",
          "社内サイトの公開対象Vaultはmainだけです。",
        );
      if (!!input.path === !!input.doc_id)
        throw new PublicationError(
          "INVALID_INPUT",
          "pathまたはdoc_idを一つ指定してください。",
        );
      if (input.doc_id && !ID.test(input.doc_id))
        throw new PublicationError("INVALID_ID", "doc_idが不正です。");
      const repo = this.repo();
      await repo.assertPrivate();
      const snapshot = await repo.snapshot();
      const ledgerPath = `${vault}/${REGISTRY}`;
      const ledger = registry(
        snapshot.entries.has(ledgerPath)
          ? await repo.text(snapshot, ledgerPath)
          : undefined,
      );
      await verifyHistory(repo, snapshot, vault, ledger);
      const notes = await loadNotes(repo, snapshot, vault);
      identities(notes, ledger);
      const requestedPath = input.path ? safePath(input.path, true) : undefined;
      let id = input.doc_id ?? notes.find((n) => n.path === requestedPath)?.id;
      if (
        !id &&
        requestedPath &&
        snapshot.entries.has(`${vault}/${requestedPath}`)
      )
        id = frontmatter(
          await repo.text(snapshot, `${vault}/${requestedPath}`),
        ).id;
      if (!id && requestedPath)
        id = Object.entries(ledger.ids).find(
          ([, e]) => e.path === requestedPath,
        )?.[0];
      const evidence = await readState(this.options.office);
      const current = id ? notes.find((n) => n.id === id) : undefined;
      const syncObservation = await observeSync(this.options.office);
      const registration =
        id && ledger.ids[id]
          ? ledger.ids[id]!.retired
            ? "retired"
            : "registered"
          : "unregistered";
      const base = {
        doc_id: id ?? null,
        sourceCommit: snapshot.head,
        registration,
        deployStateCommit: evidence.head ?? null,
        nextSyncAt: nextSync(),
        syncObservation,
        url: id ? `https://work.zuikaku.biz/docs/${id}` : null,
      };
      const failed =
        syncObservation.sourceCommit === snapshot.head &&
        ["failure", "timed_out", "cancelled", "action_required"].includes(
          syncObservation.conclusion ?? "",
        );
      if (failed && (current || registration === "retired") && !evidence.state)
        return ok({
          ...base,
          status: "同期失敗",
          reason:
            "対象の原本コミットを取得した同期処理が失敗しました。前回の成功状態は維持されています。",
        });
      if (!evidence.state)
        return ok({
          ...base,
          status: "状態を確認できない",
          reason: evidence.unavailable,
          limitation:
            "成功状態を取得できないため、本番の資料単位の状態を判断できません。",
        });
      const state = evidence.state;
      let oldNotes: Note[], oldSnapshot: Snapshot;
      try {
        oldSnapshot = await repo.snapshot(state.sourceCommit);
        oldNotes = await deployedNotes(repo, oldSnapshot, vault, state);
      } catch (e) {
        return ok({
          ...base,
          status: "状態を確認できない",
          reason: e instanceof PublicationError ? e.code : "INVALID_STATE",
        });
      }
      if (!id) return ok({ ...base, status: "未登録" });
      const publishedPath = state.docs[id];
      if (registration === "retired")
        return ok({
          ...base,
          status: publishedPath
            ? failed
              ? "同期失敗"
              : "公開停止待ち"
            : state.retiredIds.includes(id)
              ? "公開停止済み"
              : "状態を確認できない",
        });
      if (!current)
        return ok({
          ...base,
          status: publishedPath ? "状態を確認できない" : "未登録",
        });
      if (!publishedPath)
        return ok({
          ...base,
          status: state.retiredIds.includes(id)
            ? "状態を確認できない"
            : failed
              ? "同期失敗"
              : "公開待ち",
        });
      try {
        const old = oldNotes.find((n) => n.id === id);
        if (!old)
          throw new PublicationError("INVALID_STATE", "成功資料がありません。");
        const same =
          (await documentFingerprint(repo, snapshot, vault, current, notes)) ===
          (await documentFingerprint(repo, oldSnapshot, vault, old, oldNotes));
        return ok({
          ...base,
          status: same ? "公開済み" : failed ? "同期失敗" : "更新待ち",
          deployedSourceCommit: state.sourceCommit,
          workerVersion: state.workerVersion,
          limitation:
            "deploy-stateに記録された検証済み成功状態を根拠とします。現在のAccess設定や閲覧セッションは検査していません。",
        });
      } catch (e) {
        return ok({
          ...base,
          status: "状態を確認できない",
          reason: e instanceof PublicationError ? e.code : "INVALID_STATE",
        });
      }
    });
    if (
      !result.ok &&
      ![
        "INVALID_INPUT",
        "INVALID_ID",
        "INVALID_VAULT",
        "INVALID_PATH",
      ].includes(result.error)
    )
      return ok({
        status: "状態を確認できない",
        reason: result.error,
        message: result.message,
      });
    return result;
  }
  async trigger(input: {
    force?: boolean;
    expectedSourceCommit: string;
  }): Promise<ToolResult> {
    return this.result(async () => {
      const source = this.repo();
      await source.assertPrivate();
      if ((await source.head()) !== input.expectedSourceCommit)
        throw new PublicationError(
          "CONFLICT",
          "同期対象の原本先頭が変わりました。状態を確認してください。",
        );
      if (!this.options.office?.token)
        return ok({
          sourceRegistration: "unchanged",
          synchronization: {
            started: false,
            reason: "OFFICE_TOKEN_NOT_CONFIGURED",
          },
          nextSyncAt: nextSync(),
        });
      const office = new PublicationRepository(this.options.office);
      let dispatchAttempted = false;
      try {
        await office.assertPrivate();
        dispatchAttempted = true;
        const dispatch = await office.api<
          { workflow_run_id?: number; html_url?: string } | undefined
        >("/actions/workflows/sync.yml/dispatches", "POST", {
          ref: "main",
          inputs: { force: input.force ?? false },
        });
        return ok({
          sourceRegistration: "unchanged",
          synchronization: {
            started: true,
            force: input.force ?? false,
            runId: dispatch?.workflow_run_id ?? null,
            runUrl: dispatch?.html_url ?? null,
            limitation:
              "ワークフローは実行時の最新原本を取得します。起動受付は公開成功を意味しません。",
          },
        });
      } catch (e) {
        return ok({
          sourceRegistration: "unchanged",
          synchronization: {
            started:
              dispatchAttempted &&
              e instanceof PublicationError &&
              e.code === "GITHUB_UNAVAILABLE"
                ? null
                : false,
            reason:
              dispatchAttempted &&
              e instanceof PublicationError &&
              e.code === "GITHUB_UNAVAILABLE"
                ? "DISPATCH_OUTCOME_UNKNOWN"
                : e instanceof PublicationError
                  ? e.code
                  : "GITHUB_ERROR",
            message:
              "起動受付の成否が不明な場合は自動再実行せず、Actionsで確認してください。原本登録は取り消しません。",
          },
          nextSyncAt: nextSync(),
        });
      }
    });
  }
}
