import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { createReviewCheckpointManager } from "./review-checkpoints.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "devspace-review-checkpoints-test-"));

try {
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "devspace@example.com"]);
  await git(root, ["config", "user.name", "DevSpace Test"]);
  await writeFile(join(root, "README.md"), "hello\n");
  await writeFile(join(root, "gbk.txt"), iconv.encode("旧内容\n", "gb18030"));
  await git(root, ["add", "README.md", "gbk.txt"]);
  await git(root, ["commit", "-m", "Initial commit"]);

  const manager = createReviewCheckpointManager();
  await manager.initializeWorkspace({ workspaceId: "ws_review", root });

  const clean = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(clean.summary.files, 0);
  assert.equal(clean.patch, "");
  assert.match(clean.result, /No changes/);

  await writeFile(join(root, "README.md"), "hello\nworld\n");
  await writeFile(join(root, "new.txt"), "new\n");
  await writeFile(join(root, "gbk.txt"), iconv.encode("新内容\n", "gb18030"));

  const firstReview = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: false,
  });
  assert.equal(firstReview.summary.files, 3);
  assert.equal(firstReview.summary.additions, 3);
  assert.equal(firstReview.summary.removals, 1);
  assert.equal(firstReview.files.some((file) => file.path === "README.md"), true);
  assert.equal(firstReview.files.some((file) => file.path === "new.txt"), true);
  assert.match(firstReview.patch, /world/);
  assert.match(firstReview.patch, /旧内容/);
  assert.match(firstReview.patch, /新内容/);
  assert.doesNotMatch(firstReview.patch, /����/);
  assert.equal(iconv.decode(await readFile(join(root, "gbk.txt")), "gb18030"), "新内容\n");

  const stillUnreviewed = await manager.reviewChanges({
    workspaceId: "ws_review",
    root,
    markReviewed: true,
  });
  assert.equal(stillUnreviewed.summary.files, 3);

  const afterReviewed = await manager.reviewChanges({ workspaceId: "ws_review", root });
  assert.equal(afterReviewed.summary.files, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
