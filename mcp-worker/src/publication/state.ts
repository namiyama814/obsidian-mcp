import type { GitHubRepoConfig } from "../github/client.ts";
import {
  PublicationError,
  PublicationRepository,
  type Snapshot,
} from "./repository.ts";
import {
  ID,
  SHARED,
  identities,
  loadNotes,
  references,
  resolve,
  safePath,
  shared,
  type Note,
} from "./content.ts";
import { createHash } from "node:crypto";
export type DeployState = {
  version: 1;
  sourceCommit: string;
  workerVersion: string;
  markdownHash: string;
  contentHash: string;
  registryHash: string;
  codeHash: string;
  docs: Record<string, string>;
  attachments: string[];
  retiredIds: string[];
};
export type StateEvidence = {
  head?: string;
  state?: DeployState;
  unavailable?: string;
};
export function parseState(text: string): DeployState {
  const s = JSON.parse(text) as DeployState;
  if (
    !s ||
    s.version !== 1 ||
    !/^[a-f0-9]{40}$/.test(s.sourceCommit) ||
    typeof s.workerVersion !== "string" ||
    !s.workerVersion ||
    [s.markdownHash, s.contentHash, s.registryHash, s.codeHash].some(
      (h) => typeof h !== "string" || !/^[a-f0-9]{64}$/.test(h),
    ) ||
    !s.docs ||
    typeof s.docs !== "object" ||
    Array.isArray(s.docs) ||
    !Array.isArray(s.attachments) ||
    !Array.isArray(s.retiredIds)
  )
    throw new PublicationError("INVALID_STATE", "成功状態の形式が不正です。");
  const folded = new Set<string>();
  for (const [id, p] of Object.entries(s.docs)) {
    if (
      !ID.test(id) ||
      folded.has(id.toLowerCase()) ||
      !shared(safePath(p, true))
    )
      throw new PublicationError(
        "INVALID_STATE",
        "成功状態のID対応表が不正です。",
      );
    folded.add(id.toLowerCase());
  }
  if (
    s.retiredIds.some(
      (id) => typeof id !== "string" || !ID.test(id) || s.docs[id],
    ) ||
    s.attachments.some((p) => typeof p !== "string" || !shared(safePath(p)))
  )
    throw new PublicationError(
      "INVALID_STATE",
      "成功状態の添付・廃止IDが不正です。",
    );
  return s;
}
export async function readState(
  config?: GitHubRepoConfig,
): Promise<StateEvidence> {
  if (!config?.token) return { unavailable: "OFFICE_TOKEN_NOT_CONFIGURED" };
  const repo = new PublicationRepository(config);
  try {
    await repo.assertPrivate();
    const head = await repo.head("deploy-state");
    const snapshot = await repo.snapshot(head);
    return { head, state: parseState(await repo.text(snapshot, "state.json")) };
  } catch (e) {
    return {
      unavailable: e instanceof PublicationError ? e.code : "INVALID_STATE",
    };
  }
}
/** Compare only this document plus resolved dependencies; unrelated commits do not cause pending updates. */
export async function documentFingerprint(
  repo: PublicationRepository,
  snapshot: Snapshot,
  vault: string,
  note: Note,
  notes: Note[],
) {
  const paths = [...snapshot.entries.keys()]
    .filter(
      (p) =>
        p.startsWith(`${vault}/${SHARED}/`) &&
        snapshot.entries.get(p)?.type === "blob",
    )
    .map((p) => p.slice(vault.length + 1));
  const docs = identities(notes);
  const dependencies: [string, string][] = [];
  for (const ref of references(note.content)) {
    const target = resolve(ref, note.path, paths).path;
    if (!target) continue;
    if (!shared(target))
      throw new PublicationError(
        "NON_SHARED_REFERENCE",
        "非共有参照があります。",
      );
    const entry = repo.regular(snapshot, `${vault}/${target}`);
    dependencies.push([
      target,
      target.endsWith(".md")
        ? (Object.entries(docs).find(([, p]) => p === target)?.[0] ?? "")
        : entry.sha,
    ]);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        note.path,
        repo.regular(snapshot, `${vault}/${note.path}`).sha,
        dependencies.sort(),
      ]),
    )
    .digest("hex");
}
export function digestFiles(files: { path: string; bytes: Uint8Array }[]) {
  const digest = createHash("sha256");
  for (const file of [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    const name = Buffer.from(file.path);
    digest
      .update(String(name.length) + ":")
      .update(name)
      .update(String(file.bytes.length) + ":")
      .update(file.bytes);
  }
  return digest.digest("hex");
}
export async function deployedNotes(
  repo: PublicationRepository,
  snapshot: Snapshot,
  vault: string,
  state: DeployState,
) {
  const notes = await loadNotes(repo, snapshot, vault);
  if (
    JSON.stringify(Object.entries(identities(notes)).sort()) !==
    JSON.stringify(Object.entries(state.docs).sort())
  )
    throw new PublicationError(
      "INVALID_STATE",
      "成功状態と原本コミットのID対応が一致しません。",
    );
  const bytes = async (p: string) =>
    Buffer.from(
      await repo.blob(repo.regular(snapshot, `${vault}/${p}`).sha),
      "base64",
    );
  const markdown = await Promise.all(
    notes.map(async (n) => ({ path: n.path, bytes: await bytes(n.path) })),
  );
  const attachments: { path: string; bytes: Uint8Array }[] = [];
  for (const p of state.attachments)
    attachments.push({ path: p, bytes: await bytes(p) });
  const registryHash = createHash("sha256")
    .update(await bytes(".docs-id-registry.json"))
    .digest("hex");
  if (
    digestFiles(markdown) !== state.markdownHash ||
    digestFiles([...markdown, ...attachments]) !== state.contentHash ||
    registryHash !== state.registryHash
  )
    throw new PublicationError(
      "INVALID_STATE",
      "成功ハッシュと原本コミットの内容が一致しません。",
    );
  return notes;
}

export type SyncObservation = {
  runId?: number;
  runUrl?: string;
  conclusion?: string | null;
  status?: string;
  sourceCommit?: string;
  reason?: string;
};
/** Extract only a full SHA emitted by actions/checkout within the source-checkout step.
 * Never return or log workflow logs, which can contain private paths or masked credentials.
 */
export function checkoutSourceCommit(
  log: string,
  started: string,
  completed: string,
): string | undefined {
  const start = Date.parse(started),
    end = Date.parse(completed);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  let command = false;
  for (const line of log.split("\n")) {
    const match = /^(\S+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const time = Date.parse(match[1]!);
    if (!Number.isFinite(time) || time < start || time > end) continue;
    const text = match[2]!.trim();
    if (command && /^[a-f0-9]{40}$/.test(text)) return text;
    command = /\bgit log -1 --format=%H$/.test(text);
  }
  return undefined;
}
export async function observeSync(
  config?: GitHubRepoConfig,
): Promise<SyncObservation> {
  if (!config?.token) return { reason: "OFFICE_TOKEN_NOT_CONFIGURED" };
  const repo = new PublicationRepository(config);
  try {
    const runs = await repo.api<{
      workflow_runs: {
        id: number;
        html_url: string;
        conclusion: string | null;
        status: string;
      }[];
    }>("/actions/workflows/sync.yml/runs?branch=main&per_page=1");
    const run = runs.workflow_runs[0];
    if (!run) return { reason: "NO_SYNC_RUN" };
    const observation: SyncObservation = {
      runId: run.id,
      runUrl: run.html_url,
      conclusion: run.conclusion,
      status: run.status,
    };
    if (
      !["failure", "timed_out", "cancelled", "action_required"].includes(
        run.conclusion ?? "",
      )
    )
      return observation;
    const jobs = await repo.api<{
      jobs: {
        id: number;
        steps: {
          name: string;
          started_at: string;
          completed_at: string;
          conclusion: string;
        }[];
      }[];
    }>(`/actions/runs/${run.id}/jobs?per_page=100`);
    if (jobs.jobs.length >= 100)
      return { ...observation, reason: "JOB_LIST_INCOMPLETE" };
    for (const job of jobs.jobs) {
      const step = job.steps.find(
        (s) =>
          s.name === "Checkout Obsidian read-only" &&
          s.conclusion === "success",
      );
      if (!step) continue;
      observation.sourceCommit = checkoutSourceCommit(
        await repo.jobLog(job.id),
        step.started_at,
        step.completed_at,
      );
      if (observation.sourceCommit) return observation;
    }
    return { ...observation, reason: "SOURCE_COMMIT_NOT_PROVEN" };
  } catch (e) {
    return {
      reason:
        e instanceof PublicationError ? e.code : "SYNC_EVIDENCE_UNAVAILABLE",
    };
  }
}
