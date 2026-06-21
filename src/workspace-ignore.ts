import ignore from "ignore";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const IGNORE_FILE_NAMES = [".gitignore", ".devspaceignore"];

interface IgnoreFrame {
  dir: string;
  ig: ReturnType<typeof ignore>;
}

type Entries = Awaited<ReturnType<typeof readDirents>>;
async function readDirents(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function isIgnoredByStack(path: string, stack: IgnoreFrame[], isDir: boolean): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (path !== frame.dir && !path.startsWith(frame.dir + sep)) continue;
    const rel = relative(frame.dir, path).split(sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    try {
      if (frame.ig.ignores(rel)) return true;
      if (isDir && frame.ig.ignores(rel + "/")) return true;
    } catch {
      // malformed pattern; treat as non-matching
    }
  }
  return false;
}

export async function walkWorkspace(
  directory: string,
  visit: (path: string, entry: { name: string; isFile(): boolean; isDirectory(): boolean }) => Promise<void> | void,
  skippedDirs: Set<string>,
  alwaysVisitFiles?: Set<string>,
): Promise<void> {
  async function recurse(dir: string, stack: IgnoreFrame[]): Promise<void> {
    const entries: Entries = await readDirents(dir);
    if (!entries) return;

    let childStack = stack;
    const hasIgnore = entries.some(
      (e) => e.isFile() && IGNORE_FILE_NAMES.includes(e.name),
    );
    if (hasIgnore) {
      const ig = ignore();
      for (const name of IGNORE_FILE_NAMES) {
        try {
          const content = await readFile(join(dir, name), "utf8");
          ig.add(content);
        } catch {
          // file vanished or unreadable; skip
        }
      }
      childStack = [...stack, { dir, ig }];
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name)) continue;
        if (isIgnoredByStack(path, childStack, true)) continue;
        await recurse(path, childStack);
        continue;
      }

      if (entry.isFile()) {
        if (alwaysVisitFiles?.has(entry.name)) {
          await visit(path, entry);
          continue;
        }
        if (isIgnoredByStack(path, childStack, false)) continue;
        await visit(path, entry);
      }
    }
  }

  await recurse(directory, []);
}
