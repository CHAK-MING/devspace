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
  let ignored = false;
  for (const frame of stack) {
    if (path !== frame.dir && !path.startsWith(frame.dir + sep)) continue;
    const rel = relative(frame.dir, path).split(sep).join("/");
    if (!rel || rel.startsWith("..")) continue;
    try {
      const result = frame.ig.test(isDir ? `${rel}/` : rel);
      if (result.ignored) ignored = true;
      else if (result.unignored) ignored = false;
    } catch {
      // malformed pattern; treat as non-matching
    }
  }
  return ignored;
}

export async function walkWorkspace(
  directory: string,
  visit: (
    path: string,
    entry: { name: string; isFile(): boolean; isDirectory(): boolean },
  ) => Promise<boolean | void> | boolean | void,
  skippedDirs: Set<string>,
  alwaysVisitFiles?: Set<string>,
): Promise<void> {
  async function recurse(dir: string, stack: IgnoreFrame[]): Promise<boolean> {
    const entries: Entries = await readDirents(dir);
    if (!entries) return true;
    entries.sort((a, b) => a.name.localeCompare(b.name));

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
        if (!(await recurse(path, childStack))) return false;
        continue;
      }

      if (entry.isFile()) {
        if (alwaysVisitFiles?.has(entry.name)) {
          if ((await visit(path, entry)) === false) return false;
          continue;
        }
        if (isIgnoredByStack(path, childStack, false)) continue;
        if ((await visit(path, entry)) === false) return false;
      }
    }
    return true;
  }

  await recurse(directory, []);
}
