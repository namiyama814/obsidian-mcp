/** Validate fabricated live-test commits with the existing officeSystem implementation, unchanged. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
if (process.env.PUBLICATION_LIVE_TEST !== "1")
  throw new Error("Set PUBLICATION_LIVE_TEST=1 for dummy repository reads.");
const office = process.env.OFFICE_SYSTEM_PATH;
const published = process.env.PUBLICATION_TEST_COMMIT;
const stopped = process.env.PUBLICATION_STOP_COMMIT;
if (
  !office ||
  !published ||
  !stopped ||
  ![published, stopped].every((s) => /^[a-f0-9]{40}$/.test(s))
)
  throw new Error(
    "Set OFFICE_SYSTEM_PATH, PUBLICATION_TEST_COMMIT and PUBLICATION_STOP_COMMIT.",
  );
const { extract } = await import(
  pathToFileURL(path.join(office, "scripts/content.ts")).href
);
const directory = await realpath(
  await mkdtemp(path.join(tmpdir(), "obsidian-publication-oracle-")),
);
try {
  execFileSync(
    "gh",
    ["repo", "clone", "namiyama814/obsidian-mcp-publication-test", directory],
    { stdio: "pipe" },
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
  git("checkout", "--detach", published);
  const first = await extract(path.join(directory, "main"));
  assert.equal(first.notes.length, 1);
  assert.equal(first.attachmentFiles.length, 1);
  assert.equal(Object.keys(first.snapshot.docs).length, 1);
  assert(
    [...first.staged.values()].every(
      (value) => !String(value).includes("private_property"),
    ),
  );
  git("checkout", "--detach", stopped);
  const last = await extract(path.join(directory, "main"), first.snapshot);
  assert.equal(last.notes.length, 0);
  assert.equal(last.attachmentFiles.length, 0);
  assert.deepEqual(last.snapshot.retiredIds, Object.keys(first.snapshot.docs));
  console.log(
    JSON.stringify(
      {
        publicationCommit: published,
        stopCommit: stopped,
        checks: [
          "officeSystem.extract",
          "registry Git history unchanged",
          "document Git history",
          "shared reference extraction",
          "frontmatter metadata filtering",
          "stop retiredIds / previous successful snapshot compatibility",
        ],
        passed: true,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
