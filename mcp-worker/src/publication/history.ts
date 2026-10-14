import {
  PublicationError,
  type PublicationRepository,
  type Snapshot,
} from "./repository.ts";
import {
  REGISTRY,
  SHARED,
  identities,
  identityKey,
  loadNotes,
  registry,
  type Registry,
} from "./content.ts";

export function validateLedgerHistory(old: Registry, current: Registry) {
  for (const [id, e] of Object.entries(old.ids)) {
    const now = current.ids[id];
    if (!now || now.path !== e.path || (e.retired && !now.retired))
      throw new PublicationError(
        "REGISTRY_HISTORY_CHANGED",
        "台帳の過去の登録は変更・削除できません。",
      );
    for (const move of old.reviewedMoves?.[id] ?? [])
      if (!current.reviewedMoves?.[id]?.includes(move))
        throw new PublicationError(
          "REGISTRY_HISTORY_CHANGED",
          "移動確認履歴を削除できません。",
        );
  }
  for (const key of old.reviewedChanges ?? [])
    if (!current.reviewedChanges?.includes(key))
      throw new PublicationError(
        "REGISTRY_HISTORY_CHANGED",
        "変更確認履歴を削除できません。",
      );
}
export function validateTransition(
  before: Record<string, string>,
  after: Record<string, string>,
  current: Registry,
  retired: Set<string>,
  moves = false,
) {
  const removed = Object.keys(before).filter((id) => !after[id]);
  const added = Object.keys(after).filter((id) => !before[id]);
  for (const [id, p] of Object.entries(after)) {
    if ([...retired].some((old) => old.toLowerCase() === id.toLowerCase()))
      throw new PublicationError(
        "RETIRED_ID",
        "Git履歴で廃止されたIDは再利用できません。",
      );
    if (
      Object.keys(before).some(
        (old) => old !== id && old.toLowerCase() === id.toLowerCase(),
      )
    )
      throw new PublicationError(
        "DUPLICATE_ID",
        "過去のIDと大文字小文字だけ異なるIDは使用できません。",
      );
    if (
      Object.entries(before).some(
        ([old, oldPath]) => old !== id && oldPath === p,
      )
    )
      throw new PublicationError("ID_CHANGED", "既存文書のID変更は禁止です。");
    if (
      moves &&
      before[id] &&
      before[id] !== p &&
      !current.reviewedMoves?.[id]?.includes(`${before[id]} -> ${p}`)
    )
      throw new PublicationError("UNREVIEWED_MOVE", "移動確認記録が必要です。");
  }
  if (
    removed.length &&
    added.length &&
    !current.reviewedChanges?.includes(identityKey(before, after))
  )
    throw new PublicationError(
      "UNREVIEWED_CHANGE",
      "削除・新規ID追加の組合せの確認が必要です。",
    );
  removed.forEach((id) => retired.add(id));
}
export async function verifyHistory(
  repo: PublicationRepository,
  snapshot: Snapshot,
  vault: string,
  current: Registry,
) {
  const ledgerPath = `${vault}/${REGISTRY}`;
  for (const commit of await repo.commits(snapshot.head, ledgerPath)) {
    const oldSnapshot = await repo.snapshot(commit.sha);
    if (!oldSnapshot.entries.has(ledgerPath))
      throw new PublicationError(
        "REGISTRY_HISTORY_CHANGED",
        "台帳削除の履歴があります。",
      );
    validateLedgerHistory(
      registry(await repo.text(oldSnapshot, ledgerPath)),
      current,
    );
  }
  const retired = new Set<string>();
  let before: Record<string, string> = {};
  const commits = (
    await repo.commits(snapshot.head, `${vault}/${SHARED}`)
  ).reverse();
  for (const commit of commits) {
    const oldSnapshot =
      commit.sha === snapshot.head ? snapshot : await repo.snapshot(commit.sha);
    const after = identities(
      await loadNotes(repo, oldSnapshot, vault),
      undefined,
      false,
    );
    validateTransition(before, after, current, retired);
    before = after;
  }
  const after = identities(
    await loadNotes(repo, snapshot, vault),
    undefined,
    false,
  );
  validateTransition(before, after, current, retired);
  return retired;
}
