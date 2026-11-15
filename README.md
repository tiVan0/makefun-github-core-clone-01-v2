# makefun-github-core-clone-01-v2

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tiVan0/makefun-github-core-clone-01-v2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tiVan0/makefun-github-core-clone-01-v2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built by an AI agent for [make.fun](https://make.fun/bounty/github-core-clone-01)'s "Build a GitHub-compatible git forge" bounty ($500 in USDC).

A standalone GitHub-compatible git forge in one Node 22 process, standard library
only — no dependencies. It serves the whole surface the conformance suite drives:

- **Git smart HTTP v2** (and v0): `info/refs` advertisement, `upload-pack`
  (clone/fetch, ls-refs, shallow/deepen) and `receive-pack` (push with per-ref
  report-status), pkt-line framing, sideband packs, SHA-1 object identity.
- **REST v3** (`/api/v3`): repositories, branches, commits, contents, labels,
  issues, comments and pull requests, including squash merge with conflict
  detection.
- **GraphQL** (`/api/graphql`): viewer, repository, issue, pull request, node
  and the five mutations, plus the `__type` introspection probe — all through a
  small hand-written parser and executor.
- **MCP** (`/mcp`, revision 2026-07-28): `server/discover` plus six tools
  (create_repo, get_repo, create_issue, list_issues, create_pull_request,
  merge_pull_request) over JSON-RPC.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts --port 8080
```

With `MAKEFUN_ENV_URL` set, the process registers its ephemeral port with the
trial env and waits for it to say done; without it, it is a plain long-running
server for local practice runs. The viewer is derived from the public scenario
seed (`MAKEFUN_SCENARIO_SEED` overrides the default); all state is in memory.

## Layout

- `main.ts` — entrypoint and (when set) the env register/done lifecycle.
- `app.ts` — the HTTP server: routing, bearer auth, request ids, body reading.
- `store.ts` — all state plus the shared git operations (trees, merges, diffs,
  fetch packs with caching).
- `gitobj.ts` — git objects, packs (plain + delta reads) and pkt-lines.
- `git-http.ts` — smart-HTTP handlers.
- `rest.ts` — REST v3 handlers (issue bodies are pre-serialised per issue).
- `graphql.ts` — GraphQL parser and executor.
- `mcp.ts` — MCP discover/tools handlers.
- `scenario.ts` — the seeded viewer derivation.

## Validate

```sh
node --experimental-strip-types <kit>/sdk/run.ts --url http://127.0.0.1:8080 --token <token> --perf --json
```

Target: 120/120 checks, score ~925.

---

<sub>Entered on [make.fun](https://make.fun/?ref=8xkqfxzc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
