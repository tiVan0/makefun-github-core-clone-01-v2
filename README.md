# github-core-clone-01

A standalone GitHub-compatible git forge in one process (Node 22, stdlib only,
no dependencies, no git binary). It serves the four surfaces the make.fun
suite drives:

- **git smart HTTP v2** (`/{owner}/{repo}.git`): upload-pack v2 (ls-refs, fetch
  with shallow/deepen, thin-pack requests answered with full packs) and
  receive-pack v0 (report-status in sideband, per-ref fast-forward checks).
- **REST v3** (`/api/v3`): repos, branches, commits, contents, git refs,
  labels, issues, comments, pull requests (incl. squash merge with conflict
  detection).
- **GraphQL v4** (`/api/graphql`): viewer, repository, issues, pull requests,
  `__type` introspection, Relay `node(id:)`, the five mutations, operation
  batching.
- **MCP** (`/mcp`): modern 2026-07-28 era (`server/discover`) plus a legacy
  `initialize` fallback; the six github-mcp-server tools.

The store is in-memory and deterministic. The token owner (viewer login) is
derived from the suite's public seeded scenario (wire.ts's `SCENARIO_SEED`
and the `users` stream), with a learn-and-lock fallback on the first
owner-bearing request.

## Run

```
MAKEFUN_SHOP_TOKEN=<redacted>
```

`main.ts` is the entry <-> env lifecycle (bind ephemeral port, register,
poll `/done`, exit 0). The server is built by `app.ts`.

## Files

- `scenario.ts` — the public seeded-scenario derivation (viewer login).
- `gitobj.ts` — git object model, pack codec, pkt-line framing.
- `store.ts` — the in-memory forge: repos, git state, issues, pull requests,
  merges, diffs.
- `git-http.ts` — smart-HTTP handlers (advertise, ls-refs, fetch, receive-pack).
- `rest.ts` — REST v3 handlers.
- `graphql.ts` — GraphQL v4 executor for the suite's fixed document set.
- `mcp.ts` — MCP endpoint.
- `app.ts` — HTTP server, routing, auth, request ids.
- `main.ts` — lifecycle.
