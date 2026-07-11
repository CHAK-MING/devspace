import assert from "node:assert/strict";
import { classifyCommand } from "./command-classifier.js";

assert.deepEqual(classifyCommand("git status").kind, "inspection");
assert.deepEqual(classifyCommand("rg finish_workspace_task src").evidenceKind, "targeted-search");
assert.deepEqual(classifyCommand("journalctl -u devspace.service --no-pager").evidenceKind, "runtime-log-inspected");
assert.deepEqual(classifyCommand("systemctl status devspace.service").evidenceKind, "runtime-log-inspected");
assert.deepEqual(classifyCommand("npm test").kind, "verification");
assert.deepEqual(classifyCommand("npm run typecheck").kind, "verification");
assert.deepEqual(classifyCommand("npx tsc -p tsconfig.json --noEmit").kind, "verification");
assert.deepEqual(classifyCommand("go test ./...").kind, "verification");
assert.deepEqual(classifyCommand("openspec validate improve-completion-checkpoints --strict").kind, "verification");
assert.deepEqual(classifyCommand("echo hello").kind, "unknown");
assert.deepEqual(classifyCommand("cat README.md > /tmp/out").kind, "potential_mutation");
assert.deepEqual(classifyCommand("sed -i 's/a/b/' src/app.ts").kind, "potential_mutation");

console.log("All command classifier tests passed.");
