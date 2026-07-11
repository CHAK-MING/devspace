import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import iconv from "iconv-lite";
import { editFileTool, grepFilesTool } from "./pi-tools.js";

const root = await mkdtemp(join(tmpdir(), "devspace-pi-tools-test-"));
const context = { cwd: root, root };

try {
  await mkdir(join(root, "nested"));
  await writeFile(join(root, "a.txt"), "needle one\n");
  await writeFile(
    join(root, "nested", "legacy.txt"),
    iconv.encode("中文 needle two\n", "gb18030"),
  );

  const result = await grepFilesTool(
    { pattern: "needle", literal: true },
    context,
  );
  assert.equal(result.isError, undefined);
  const text = result.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  assert.match(text, /a\.txt:1:needle one/);
  assert.match(text, /nested\/legacy\.txt:1:中文 needle two/);

  const missing = await grepFilesTool(
    { pattern: "needle", path: "missing" },
    context,
  );
  assert.equal(missing.isError, true);
  assert.match(
    missing.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
    /Search path does not exist: missing/,
  );

  const limited = await grepFilesTool(
    { pattern: "needle", literal: true, limit: 1 },
    context,
  );
  assert.deepEqual(limited.details, { matchLimitReached: 1 });
  assert.match(
    limited.content.map((item) => item.type === "text" ? item.text : "").join("\n"),
    /Results truncated at 1 matches/,
  );

  await writeFile(join(root, "nested", "ignored.md"), "needle ignored\n");
  const included = await grepFilesTool(
    { pattern: "needle", literal: true, include: "**/*.txt" },
    context,
  );
  const includedText = included.content.map((item) => item.type === "text" ? item.text : "").join("\n");
  assert.match(includedText, /nested\/legacy\.txt/);
  assert.doesNotMatch(includedText, /ignored\.md/);

  const editPath = join(root, "edit.txt");
  const original = "alpha\nrepeat\nmiddle\nrepeat\nomega\n";
  await writeFile(editPath, original);

  const nonUnique = await editFileTool(
    { path: "edit.txt", edits: [{ oldText: "repeat", newText: "changed" }] },
    context,
  );
  assert.equal(nonUnique.isError, true);
  assert.match(toolText(nonUnique), /Found 2 occurrences of edits\[0\] in edit\.txt at lines 2, 4/);
  assert.equal(await readFile(editPath, "utf8"), original);

  const missingEdit = await editFileTool(
    { path: "edit.txt", edits: [{ oldText: "missing target", newText: "changed" }] },
    context,
  );
  assert.equal(missingEdit.isError, true);
  assert.match(toolText(missingEdit), /Could not find edits\[0\] in edit\.txt/);
  assert.match(toolText(missingEdit), /Re-read the target region before retrying/);
  assert.equal(await readFile(editPath, "utf8"), original);

  const overlapping = await editFileTool(
    {
      path: "edit.txt",
      edits: [
        { oldText: "alpha\nrepeat", newText: "first" },
        { oldText: "repeat\nmiddle", newText: "second" },
      ],
    },
    context,
  );
  assert.equal(overlapping.isError, true);
  assert.match(toolText(overlapping), /edits\[1\] overlaps edits\[0\]/);
  assert.equal(await readFile(editPath, "utf8"), original);

  const matchesReplacementOnly = await editFileTool(
    {
      path: "edit.txt",
      edits: [
        { oldText: "alpha", newText: "beta" },
        { oldText: "beta", newText: "gamma" },
      ],
    },
    context,
  );
  assert.equal(matchesReplacementOnly.isError, true);
  assert.match(toolText(matchesReplacementOnly), /Could not find edits\[1\] in edit\.txt/);
  assert.equal(await readFile(editPath, "utf8"), original);

  const edited = await editFileTool(
    {
      path: "edit.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "omega", newText: "OMEGA" },
      ],
    },
    context,
  );
  assert.equal(edited.isError, undefined);
  assert.equal(await readFile(editPath, "utf8"), "ALPHA\nrepeat\nmiddle\nrepeat\nOMEGA\n");
} finally {
  await rm(root, { recursive: true, force: true });
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((item) => item.type === "text" ? item.text ?? "" : "").join("\n");
}

console.log("All pi tool tests passed.");
