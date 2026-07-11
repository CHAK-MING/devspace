# DevSpace

This project exposes a local development workspace over MCP so ChatGPT, Claude,
or another MCP-capable host can operate directly on this machine's approved
development directories.

The goal is not to delegate work to a separate local coding agent. The MCP host
should call tools that read files, edit files, search code, and run shell
commands directly against approved local project roots.

Pi's SDK is currently used as the backend adapter for mature local coding
primitives such as read, edit, write, grep, find, ls, and bash. DevSpace wraps
those primitives behind a remote Streamable HTTP MCP interface, suitable for use
through a Cloudflare Tunnel.

The model-facing workflow is workspace based. MCP clients should call
`open_workspace` once per local project directory or worktree, then reuse the
returned `workspaceId` for subsequent tool calls in that same folder. Do not
call `open_workspace` again for the same folder unless the `workspaceId` is
rejected as unknown, the client switches folders/worktrees or checkout/worktree
mode, or the user explicitly asks to reopen. `AGENTS.md` files are returned
automatically by `open_workspace` and by later tool calls when the requested path
enters a directory with instructions that have not been loaded for that
workspace.

Core constraints:

- Treat this as remote access to the local machine; security is part of the
  core design, not a later add-on.
- Start with a narrow filesystem allowlist.
- Prefer explicit, inspectable tool calls over autonomous local agent loops.
- Keep the first version small enough to validate with real ChatGPT/Claude MCP
  clients before adding UI or workflow features.

Codex reasoning guardrails:

- Spend the reasoning needed to solve the task correctly; do not rush to a
  pattern-matched answer when the task asks for a guarantee, bound, proof,
  count, or edge-case-sensitive conclusion.
- Do not send optional commentary messages. Use commentary only when a tool call
  requires it or when the user explicitly asks for status updates.
- For tasks that do not need tools, complete the reasoning first, then answer
  only in the final response.
- Prefer first-principles reasoning over surface-pattern matching.
- Before solving a problem, separate observable information, controllable
  actions, and the exact guarantee required by the question.
- If a property can be observed, touched, marked, sorted, selected adaptively, or
  otherwise controlled, use a staged/adaptive strategy that exploits that
  control instead of reducing the problem to blind one-shot sampling.
- For quantitative, logical, boundary, or guarantee-style problems, prove both
  worst-case sufficiency and the matching lower bound before giving the final
  answer.
- If the answer is numeric, re-check the arithmetic and ensure the final number
  answers the exact question asked.
- Keep these as general working rules. Do not specialize them for a particular
  benchmark, prompt, expected answer, or evaluation script.
