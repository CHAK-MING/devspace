import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assertAllowedPath, expandHomePath, resolveAllowedPath } from "./roots.js";

const home = homedir();

assert.equal(expandHomePath("~"), home);
assert.equal(expandHomePath("~/personal/devspace"), resolve(home, "personal", "devspace"));
assert.equal(expandHomePath("~user/project"), "~user/project");
assert.equal(expandHomePath("$HOME/project"), "$HOME/project");

assert.equal(
  assertAllowedPath("~/personal/devspace", [join(home, "personal")]),
  resolve(home, "personal", "devspace"),
);

assert.equal(
  assertAllowedPath("~/personal/devspace", ["~/personal"]),
  resolve(home, "personal", "devspace"),
);

// ~ now expands to home before resolving; here it lands outside /workspace,
// so the allowed-roots check rejects it (previously ~ was treated as a literal
// directory name under cwd, which silently produced a wrong path).
assert.throws(
  () => resolveAllowedPath("~/file.txt", "/workspace", ["/workspace"]),
  /Path is outside allowed roots/,
);

// When home is itself an allowed root, ~ expansion is accepted.
assert.equal(
  resolveAllowedPath("~/file.txt", "/workspace", [home]),
  resolve(home, "file.txt"),
);

// Relative paths are still resolved against cwd (no ~ expansion).
assert.equal(
  resolveAllowedPath("file.txt", "/workspace", ["/workspace"]),
  resolve("/workspace", "file.txt"),
);

if (process.platform === "win32") {
  assert.throws(
    () => assertAllowedPath("C:\\Users\\Administrator", ["G:\\Projects\\Dev\\Github\\devspace"]),
    /Path is outside allowed roots/,
  );
}
