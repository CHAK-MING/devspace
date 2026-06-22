# DevSpace (Fork with Performance Patches)

> **Private fork** of [`Waishnav/devspace`](https://github.com/Waishnav/devspace) with local performance patches.
> Not for public consumption. No PRs opened against upstream.
> Upstream README preserved as [`UPSTREAM_README.md`](./UPSTREAM_README.md).

DevSpace is a self-hosted MCP server that lets ChatGPT read, edit, search, and run code in your local projects. This fork adds **performance optimizations** for large workspaces (100K+ files).

## What's Modified

All changes are isolated to the `local-patches` branch. The `main` branch stays in sync with upstream.

| # | File | Change | Impact |
|---|------|--------|--------|
| 1 | `src/workspace-ignore.ts` (NEW) | `walkWorkspace` respects `.gitignore` + `.devspaceignore` hierarchically | **97x faster** walk on gitignored workspaces |
| 2 | `src/workspace-ignore.ts` | `readdirSync` → `async readdir` | Non-blocking event loop, ~40% faster on raw walk |
| 3 | `src/server.ts` | `readWorkspaceAppManifest()` cached at module load | Eliminates per-widget `readFileSync` |
| 4 | `src/workspace-store.ts` | `touchSession()` throttled to 1/min per workspace | Eliminates per-tool-call SQLite `UPDATE` |
| 5 | `src/git.ts` | `getGitEligibility` 3 spawns → 2 | `rev-parse --show-toplevel` already implies inside-work-tree |
| 6 | `src/pi-tools.ts` | Tool instances cached by `cwd` | Eliminates `createXxxTool(cwd)` per call |
| 7 | `src/workspaces.ts` | Removed local `walkWorkspace`, imports from `workspace-ignore.ts` | Net -7 lines |
| 8 | `package.json` | Added `ignore@^7.0.5` dependency | Hierarchical gitignore parsing |

## Benchmarks

Real production numbers on a **143,448-file / 26GB workspace** (`/home/chakming/paper/PMalloc_new`):

| Metric | Upstream v1.0.2 | This Fork | Improvement |
|---|---|---|---|
| `walkWorkspace` (with `.gitignore`) | 2,158 ms, 143K files | **22 ms, 30 files** | **97x** |
| `walkWorkspace` (no `.gitignore`) | ~2,158 ms | **1,318 ms** | ~1.6x |
| `open_workspace` MCP tool | 2,163 ms | **53 ms** | **40x** |
| Per-tool-call overhead | +1-2 ms (SQLite UPDATE) | +0 ms (throttled) | -100% |

## Prerequisites

- **Node.js** v22+ (recommend [nvm](https://github.com/nvm-sh/nvm))
- **npm** v10+
- **git**
- **ripgrep** and **fd** (auto-downloaded by DevSpace on first use to `~/.pi/agent/bin/`)
- For public access: **Cloudflare Tunnel** (or ngrok / Caddy + port forward)

## Deploy on a New Machine

```bash
# 1. Clone the fork
git clone -b local-patches git@github.com:CHAK-MING/devspace.git ~/devspace-fork
cd ~/devspace-fork

# 2. Install deps + build
npm ci
npm run build
chmod +x dist/cli.js        # CRITICAL: tsc resets dist/cli.js to 644

# 3. Replace global install
npm uninstall -g @waishnav/devspace 2>/dev/null
npm link                     # global symlink → ~/devspace-fork/dist/cli.js

# 4. Verify
devspace --version
```

## Configure DevSpace

```bash
# Set allowed workspace root (REQUIRED)
devspace config set allowedRoots "/absolute/path/to/your/workspace"

# Optional overrides
devspace config set host 127.0.0.1
devspace config set port 7676
devspace config set publicBaseUrl https://your.domain.com
```

Config lives at `~/.devspace/config.json`. The **Owner password** (for OAuth flow) is auto-generated on first run and stored at `~/.devspace/auth.json` — back it up.

## Run DevSpace

**Foreground** (for testing):
```bash
devspace serve
```

**Background** (survives shell exit):
```bash
mkdir -p ~/.devspace/logs
nohup bash -c 'trap "" HUP TERM; \
  export DEVSPACE_WIDGETS=full; \
  export DEVSPACE_TRUST_PROXY=1; \
  exec devspace serve' \
  > ~/.devspace/logs/serve.log 2>&1 < /dev/null & disown
```

To kill a backgrounded instance (it blocks SIGTERM, must use SIGKILL):
```bash
ps -u $USER -o pid,command | grep "devspace serve" | grep -v grep
kill -KILL <PID>
```

## Environment Variables

| Var | Values | Effect |
|---|---|---|
| `DEVSPACE_WIDGETS` | `full` \| `changes` \| `off` | Widget rendering mode. Use `off` on high-latency links to avoid ChatGPT widget-fetch timeouts. |
| `DEVSPACE_TRUST_PROXY` | `1` \| `0` | Trust `X-Forwarded-For` from reverse proxy (Cloudflare Tunnel, ngrok). Required when behind proxy. |
| `DEVSPACE_LOG_TOOL_CALLS` | `1` \| `0` | Log every tool call with duration. Useful for debugging perf. |

## Cloudflare Tunnel Setup

DevSpace has **no built-in tunnel**. For HTTPS access (required by ChatGPT Desktop connectors), use Cloudflare Tunnel:

1. **Create a tunnel** at [one.dash.cloudflare.com](https://one.dash.cloudflare.com/) → Networks → Tunnels → Create Tunnel.
2. **Install cloudflared** on the machine running DevSpace:
   ```bash
   # macOS
   brew install cloudflared
   # Linux
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
   chmod +x /usr/local/bin/cloudflared
   ```
3. **Run cloudflared** (replace `<TOKEN>` with your tunnel token):
   ```bash
   # macOS
   sudo nohup /opt/homebrew/bin/cloudflared tunnel run --token <TOKEN> > /tmp/cloudflared.log 2>&1 & disown

   # Linux (systemd)
   sudo tee /etc/systemd/system/cloudflared.service > /dev/null <<EOF
   [Unit]
   Description=Cloudflared Tunnel
   After=network-online.target
   Wants=network-online.target
   [Service]
   Type=notify
   ExecStart=/usr/local/bin/cloudflared --no-autoupdate tunnel run --token <TOKEN>
   Restart=on-failure
   RestartSec=5s
   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload
   sudo systemctl enable --now cloudflared
   ```
4. **Add public hostname** in CF dashboard:
   - Subdomain: e.g. `devspace`
   - Domain: your domain
   - Type: `HTTP`
   - URL: `127.0.0.1:7676`
5. **DNS**: CF auto-creates a CNAME `<sub>.<domain>` → `<tunnel-uuid>.cfargotunnel.com`.

## ChatGPT Connector Setup

ChatGPT Desktop requires **HTTPS** (won't accept `http://127.0.0.1`).

1. Open ChatGPT Desktop → **Settings** → **Apps & Connectors**.
2. Scroll to bottom → expand **Advanced settings** → toggle **Developer Mode** on.
3. Click **Create** (appears after enabling Developer Mode).
4. Enter MCP server URL: `https://devspace.<your-domain>/mcp`.
5. Browser opens OAuth flow → enter your **DevSpace Owner password** (from `~/.devspace/auth.json`).

## Workspace Optimization Tips

- **Add `.gitignore`** to your workspace. The patched `walkWorkspace` respects it hierarchically.
- **Add `.devspaceignore`** for DevSpace-specific exclusions (additive to `.gitignore`).
- Common heavy dirs to exclude: `node_modules/`, `dist/`, `build/`, `.next/`, `.turbo/`, `target/`, `vendor/`, `__pycache__/`, `.venv/`, `.zig-cache/`, `zig-out/`, `.gradle/`, `.idea/`.

## Maintenance: Sync with Upstream

This fork tracks `Waishnav/devspace` main branch. Upstream is **very active** (multiple commits/day). Rebase regularly:

```bash
cd ~/devspace-fork

# One-time: add upstream remote
git remote add upstream https://github.com/Waishnav/devspace.git

# Sync + rebuild + restart
git fetch upstream
git rebase upstream/main local-patches
npm install            # in case deps changed
npm run build
chmod +x dist/cli.js   # CRITICAL: tsc resets mode

# Restart serve (kill old PID first)
pkill -KILL -f "devspace serve"
nohup bash -c 'trap "" HUP TERM; exec devspace serve' \
  > ~/.devspace/logs/serve.log 2>&1 < /dev/null & disown
```

If rebase conflicts occur, they should only be in:
- `src/workspaces.ts` (around `findAvailableAgentsFiles` call site — 1-2 lines)
- `package.json` (`ignore` dependency line)

All other changes are in a **new file** (`src/workspace-ignore.ts`) → zero conflict risk.

## Debugging

```bash
# Live tail logs
tail -f ~/.devspace/logs/serve.log

# Check cloudflared edge assignment
curl -s http://localhost:20241/metrics | grep edge_location

# Test endpoint locally
curl -sw "\n%{time_total}s HTTP %{http_code}\n" -o /dev/null http://127.0.0.1:7676/mcp

# Benchmark walkWorkspace standalone
cd ~/devspace-fork && node -e '
  import("./dist/workspace-ignore.js").then(async m => {
    const t = performance.now(); let n = 0;
    await m.walkWorkspace("/path/to/workspace", async () => n++,
      new Set([".git",".hg",".svn",".devspace","node_modules","dist","build",".next",".turbo",".cache"]),
      new Set(["AGENTS.md","AGENTS.MD","CLAUDE.md","CLAUDE.MD"]));
    console.log(`walk: ${(performance.now()-t).toFixed(1)}ms, ${n} files`);
  });
'
```

## Branch Strategy

```
main              ← tracks upstream/main (never commit here)
local-patches     ← fork patches, rebased on main
```

## License

Inherits upstream [MIT License](./LICENSE).

## Acknowledgments

- Original work: [Waishnav/devspace](https://github.com/Waishnav/devspace)
- Upstream README: [`UPSTREAM_README.md`](./UPSTREAM_README.md)
- `ignore` npm package: [ignore](https://github.com/kaelzhang/node-ignore)
