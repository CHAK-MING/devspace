import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { walkWorkspace } from "./workspace-ignore.js";

const root = await mkdtemp(join(tmpdir(), "devspace-ignore-test-"));

try {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, ".gitignore"), "*.log\n");
  await writeFile(join(root, "root.log"), "ignored\n");
  await writeFile(join(root, "nested", ".gitignore"), "!keep.log\n");
  await writeFile(join(root, "nested", "drop.log"), "ignored\n");
  await writeFile(join(root, "nested", "keep.log"), "kept\n");

  const visited: string[] = [];
  await walkWorkspace(
    root,
    (path, entry) => {
      if (entry.isFile()) visited.push(relative(root, path).split(sep).join("/"));
    },
    new Set(),
  );

  assert.equal(visited.includes("root.log"), false);
  assert.equal(visited.includes("nested/drop.log"), false);
  assert.equal(visited.includes("nested/keep.log"), true);

  const earlyStopRoot = join(root, "early-stop");
  await mkdir(earlyStopRoot);
  await writeFile(join(earlyStopRoot, "a.txt"), "a\n");
  await writeFile(join(earlyStopRoot, "b.txt"), "b\n");
  const earlyVisited: string[] = [];
  await walkWorkspace(
    earlyStopRoot,
    (path) => {
      earlyVisited.push(relative(earlyStopRoot, path).split(sep).join("/"));
      return false;
    },
    new Set(),
  );
  assert.deepEqual(earlyVisited, ["a.txt"]);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("All workspace ignore tests passed.");
