<p align="center"><img src="mobile/web/icon-192.png" alt="" width="96" height="96" /></p>

<h1 align="center">Codex Mobile</h1>

<p align="center"><strong>OpenAI's Codex coding agent, on your phone and iPad — no PC needed.</strong><br />
With the <a href="https://github.com/Pheonix-Studio-cat/Chinook-security">Chinook Security</a> bots built in.</p>

<p align="center">
  <a href="https://pheonix-studio-cat.github.io/codex-mobile/"><strong>Open the app</strong></a> ·
  <a href="https://codespaces.new/Pheonix-Studio-cat/codex-mobile?quickstart=1">Start in Codespaces</a> ·
  <a href="mobile/README.md">How it works</a>
</p>

---

## What it is

Codex is an agent: it reads code, runs commands and edits files. A phone
cannot do that itself — iOS runs no terminal. So Codex runs in a
**GitHub Codespace**, a computer GitHub lends you, and the phone is how you
talk to it:

```
iPhone / iPad  ──HTTPS, only you──▶  your codespace:  bridge ──▶ Codex
```

Everything is done from the phone or iPad: starting the codespace, signing
in, chatting, approving commands, security scans. There is no step that needs
a PC or a terminal.

## Set up — once, from the iPad

1. **Choose a pairing token.** Any random text of at least 24 characters.
   In GitHub: _Settings → Codespaces → Secrets → New secret_, name
   `CODEX_MOBILE_TOKEN`, repository `Pheonix-Studio-cat/codex-mobile`.
2. **Start the codespace:**
   [Start in Codespaces](https://codespaces.new/Pheonix-Studio-cat/codex-mobile?quickstart=1).
   The first start installs Codex and Chinook Security and takes a few
   minutes.
3. **Open Codex Mobile.** In the codespace, under _Ports_, open port
   **8765 (Codex Mobile)**. Enter your token.
4. **Add to Home Screen** from the share menu. From now on it opens like an
   app.
5. **Sign in to Codex** in the app — _Sign in with ChatGPT_: you get a code,
   enter it on the OpenAI page. Or use an API key. It is Codex's own login,
   unchanged.

Later, stopped codespaces wake up when you open them again from
[github.com/codespaces](https://github.com/codespaces).

## Costs

GitHub's documentation (billing for Codespaces) states: personal accounts
include **120 hours of compute and 15 GB of storage per month**, and _"if your
account does not have a valid payment method on file, usage is blocked once
you use up your quota"_ — GitHub stops, it does not charge. The quota counts
core hours: the 2-core machine this project uses counts twice, so it is
**about 60 hours of use a month**. A stopped codespace uses no compute. Codex itself needs a ChatGPT plan or an API key, as always.

## What the app does

|               |                                                                                                                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chat**      | threads, answers as they are written, Markdown                                                                                                                                                     |
| **Approvals** | commands and file changes as large cards above the keyboard — only the answers Codex offers                                                                                                        |
| **Security**  | the Chinook Security bots — secrets, code, dependencies, workflows, licences — over the workspace; findings name rule and place, never the secret; a run that could not determine anything says so |
| **iPad**      | thread list beside the conversation in landscape, reading column in portrait, Split View; with a keyboard: <kbd>↩</kbd> sends, <kbd>⌘</kbd><kbd>.</kbd> stops, <kbd>⌘</kbd><kbd>K</kbd> new thread |

## Security

- The codespace port is **private**: only you, signed in to GitHub, can open
  it. The pairing token is a second lock and is never written to a log.
- The phone can use only what the app needs: no direct shell, file or config
  access. Commands are run by Codex, under its own sandbox and approval
  rules, as with the CLI.
- The page loads nothing from other sites; no tracking.

Details: [mobile/README.md](mobile/README.md).

## Checked on every change

- **Codex Mobile** — bridge tests, a Markdown fuzz test, and an end-to-end
  run in an iPhone- and iPad-sized browser against a real Codex, with a
  scripted model: approvals, streaming, reload, security scan.
- **Chinook Security** — the bots gate this fork's own code and report on
  the whole repository.

## Based on OpenAI Codex

This is a fork of [openai/codex](https://github.com/openai/codex) (Apache
License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE)). The Codex source is
unchanged; everything mobile lives in [`mobile/`](mobile/),
[`.devcontainer/`](.devcontainer/) and three workflows. For Codex itself —
the CLI, the IDE extensions, its documentation — see the
[upstream repository](https://github.com/openai/codex) and [`docs/`](docs/).

Codex Mobile is not an OpenAI product.
