# magpie-codex-relay

A [magpie](https://github.com/yetone/magpie) plugin that reuses the **ChatGPT / Codex
subscription already signed in to magpie**, and sends that provider's requests to a
third-party Codex gateway (the `openai_base_url` kind of relay), such as
`https://codex-relay.oaifree.com/backend-api/codex`.

The built-in `codex` subscription keeps working exactly as before. This plugin is a
second provider beside it — `codex-relay/<model>` — using the same sign-in and the
same account, without touching either.

[中文说明](README.md)

## What it does, and what it deliberately does not

| | |
|---|---|
| Reads | `$CODEX_HOME/auth.json` (`/config/.codex/auth.json` in the container) — **borrows the access token only** |
| Writes | Nothing. It never refreshes and never rewrites `auth.json` |
| Changes | Only the upstream address. Request body, headers and the streamed reply pass through unchanged; no protocol translation |
| Leaves alone | Refresh-token rotation — magpie's built-in Codex account and the Codex CLI own that |

**Why it does not refresh.** A Codex refresh token is spent once. magpie serialises
renewals behind a file lock (`codexMu`); a second party refreshing would spend the token
early and sign both sides out. So the plugin re-reads `auth.json` on every request —
after magpie renews in the background, the plugin simply sees the new token.

## Install

```bash
magpie plugin add github:dgqyushen/magpie-codex-relay
magpie plugin login codex-relay     # no input needed: borrows magpie's Codex sign-in
```

Requirement: magpie already has a Codex subscription signed in
(`magpie providers` shows `codex` as `signed in`).

The repository carries the `magpie-plugin` topic, so it also shows on magpie's
Plugins page.

## Configure the upstream

```bash
magpie plugin options codex-relay '{"baseURL":"https://codex-relay.oaifree.com/backend-api/codex"}'
```

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `https://codex-relay.oaifree.com/backend-api/codex` | The relay's base, up to the `/backend-api/codex` level |
| `codexVersion` | `0.172.0` | The `version` header sent upstream. The backend gates models by it; too old answers `400 requires a newer version of Codex` |

No reinstall is needed: `magpie plugin options` restarts the plugin host.

## Use

```bash
magpie provider models codex-relay      # the upstream's model list
magpie codex codex-relay/gpt-5.6-sol    # Codex runs on this provider
```

Any agent can pick `codex-relay/<model>`, beside the built-in `codex/<model>`.

## Proving the relay is in effect

A request goes to `baseURL` + the path (`/responses`, `/models`, `/wham/usage`).
Point `baseURL` at a local fake upstream: it receives the request and answers with its
own content, which proves the traffic was redirected rather than sent to the official
backend.

## Limits

- Responses protocol only (`@ai-sdk/openai`). The upstream must speak Codex's Responses API.
- If the relay wants its own key rather than a ChatGPT token, this plugin is the wrong tool:
  it only borrows the official sign-in.
- When the access token has expired and magpie has not renewed it, the upstream answers 401
  and the account is marked as needing a new sign-in. Sign the Codex subscription in again.
- One account per provider: the official sign-in. For several accounts, keep separate
  `CODEX_HOME` folders; the plugin takes the first unexpired one in order.

## Files

| File | Role |
|---|---|
| `index.mjs` | The plugin: provider, auth, and the redirecting `fetch` |
| `opencode.mjs` | Exports the plugin function (the host loads `main`) |
| `opencode2.mjs` | OpenCode 2.x `{id, setup}` face; unused here, kept as a no-op |
| `package.json` | `main`, `exports`, and the `magpie.options` defaults |

## License

MIT
