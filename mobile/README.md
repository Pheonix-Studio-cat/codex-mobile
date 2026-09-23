# Codex Mobile

Codex on your phone, running on your own computer — with the
[Chinook Security](https://github.com/Pheonix-Studio-cat/Chinook-security) bots
built into the app.

**The app:** <https://pheonix-studio-cat.github.io/codex-mobile/> — install it
from the browser's share menu ("Add to Home Screen").

The phone does not run Codex. Codex keeps running on a computer (or a cloud
machine) exactly as before; the phone is a new interface for it. Sign-in is
unchanged: it is Codex's own login, and the credentials stay where Codex
keeps them (`$CODEX_HOME`).

```
phone (this app)  --HTTPS-->  bridge (mobile/bridge)  --stdio-->  codex app-server
```

## Start the bridge

On the computer where Codex is installed:

```sh
python3 mobile/bridge/codex_mobile.py --workspace ~/my-project --fetch-chinook
```

It prints a pairing link. Open it on the phone. The token travels after the
`#`, which browsers never send to any server — not to the bridge, not to
GitHub.

- `--fetch-chinook` downloads Chinook Security at the pinned commit once.
- Python 3.9+ and `codex` on the `PATH`; nothing else to install.

### Reaching the bridge from the phone

The app on GitHub Pages is served over HTTPS, and a browser only lets an HTTPS
page talk to a bridge over HTTPS. So the phone needs an HTTPS address for the
bridge, for example a tunnel:

```sh
cloudflared tunnel --url http://127.0.0.1:8765
python3 mobile/bridge/codex_mobile.py --public-url https://<name>.trycloudflare.com
```

_The tunnel is one option among several (Tailscale, a reverse proxy); it has
not been tested with this project yet._ Without a tunnel, open the link the
bridge prints under "Open here" on the computer itself.

## What the app does

- threads, streamed answers, the commands and file changes Codex makes;
- approvals as large cards above the keyboard — only the answers Codex
  offers for that request;
- **Security:** the Chinook Security bots (secrets, code, dependencies,
  workflows, licences) over the workspace. Findings name rule and place,
  never the secret. A run that could not determine anything says so and is
  never shown as clean.

## Security model

| Measure                                                                       | Why                                                                                                |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Pairing token on every request, compared in constant time                     | the bridge is the door to your computer                                                            |
| Origin check; only the bridge itself, the published app, and `--allow-origin` | another website cannot use a token it does not have, and cannot even try from the browser          |
| Allowlist of app-server methods                                               | no `command/exec`, `fs/*`, `config/*` from the phone — commands only through Codex's approval flow |
| Requests the app cannot show are declined, not left open                      | Codex never waits for an answer nobody sees                                                        |
| Content-Security-Policy, no inline script, no third-party code                | the page loads nothing from anywhere else                                                          |
| Binds to 127.0.0.1 by default                                                 | listening on the network is an explicit choice, with a warning                                     |

`--no-hosted-ui` turns off the published app as an allowed origin.

## Tests

```sh
python3 -m unittest discover -s mobile/tests -p 'test_*.py'   # bridge
node mobile/tests/test_markdown.mjs                           # renderer
```

`mobile/tests/e2e/run_e2e.mjs` drives the app in a phone-sized browser against
a real `codex app-server` with a scripted model — approvals, streaming,
reload, the hosted page on another origin, the security scan. The
`Codex Mobile` workflow runs all three.
