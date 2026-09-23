# Codex Mobile — how it works

The setup for users is in the [main README](../README.md). This page is the
technical side.

```
iPhone / iPad ──HTTPS──▶ GitHub port forwarding ──▶ bridge ──stdio──▶ codex app-server
   (web app)            (private: only the owner)    (this dir)          (unchanged Codex)
```

## Why a codespace

Codex runs commands and writes files; iOS and iPadOS run neither a terminal
nor a local server a web page could use. The machine therefore is a GitHub
Codespace. [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)
makes it a one-tap start:

| Step          | Script                                       | What happens                                                           |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| created       | [`codespaces/setup.sh`](codespaces/setup.sh) | installs Codex (released, pinned) and Chinook Security (pinned commit) |
| started       | [`codespaces/start.sh`](codespaces/start.sh) | starts the bridge on port 8765 in the background, once                 |
| editor opened | `postAttachCommand`                          | shows the address of the app                                           |

The port stays **private** — GitHub's default: only the owner of the
codespace, signed in to GitHub, can open it. The bridge serves the app itself
on that port, so the page and the bridge share one origin.

## Why a bridge

`codex app-server --listen ws://…` rejects every request carrying an `Origin`
header, and a browser always sends one; its token is accepted only in the
`Authorization` header, which a browser cannot set on a WebSocket. Both are
deliberate protections of the app-server. The bridge
([`bridge/codex_mobile.py`](bridge/codex_mobile.py), Python standard library
only) talks to the app-server over stdio, like the TUI and the SDKs, and gives
the browser a small HTTP API with server-sent events.

## Security model

| Measure                                                                                                 | Why                                                  |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Private port                                                                                            | the first lock: GitHub sign-in                       |
| Pairing token (`CODEX_MOBILE_TOKEN` secret), compared in constant time, never logged                    | the second lock                                      |
| Origin check: the bridge itself, the codespace's forwarded address, the published app, `--allow-origin` | another website cannot use the bridge from a browser |
| Allowlist of app-server methods                                                                         | no `command/exec`, `fs/*`, `config/*` from the phone |
| Requests the app cannot show are declined                                                               | Codex never waits for an answer nobody sees          |
| Content-Security-Policy, no inline script, no third-party code                                          | the page loads nothing from elsewhere                |

Commands are run by Codex under its own sandbox and approval rules, exactly
as in the CLI; the app shows the approvals Codex asks for.

## The published app

<https://pheonix-studio-cat.github.io/codex-mobile/> is the same `web/`
directory, published by [`mobile-pages.yml`](../.github/workflows/mobile-pages.yml).
It starts the codespace. It can also pair with a bridge on a public HTTPS
address (`#bridge=https://…&token=…`, bridge option `--public-url`); a
private codespace port cannot be reached from another site, so for the
codespace the app is opened from the port itself.

## Chinook Security

The five bots (secrets, workflows, code, dependencies, licences) run in the
app's _Security_ view over the workspace. The commit is pinned in
`CHINOOK_COMMIT` in the bridge and in
[`chinook.yml`](../.github/workflows/chinook.yml); a test keeps both equal. A
bot run that could not determine anything (exit code 2) is shown as
_proves nothing_, never as clean.

## Running the bridge elsewhere

Any Linux or macOS machine with Python 3.9+ and `codex` works:

```sh
python3 mobile/bridge/codex_mobile.py --workspace ~/project --fetch-chinook
```

## Tests

```sh
python3 -m unittest discover -s mobile/tests -p 'test_*.py'   # bridge
node mobile/tests/test_markdown.mjs                           # renderer
```

[`tests/e2e/run_e2e.mjs`](tests/e2e/run_e2e.mjs) drives the app in iPhone
and iPad sized browsers against a real `codex app-server` with a scripted
model. The [`Codex Mobile`](../.github/workflows/mobile.yml) workflow runs
all three.

**Not covered by any test:** a real codespace (GitHub's port forwarding, the
secret, the scripts on GitHub's image) and a real Codex sign-in. The
codespace path was checked with the same environment variables in a
container, not in Codespaces.
