# mbot

**Delegate work to Muse. Hear back in your terminal.**

`mbot` is a zero-runtime-dependency, macOS-first CLI for the Muse desktop app. It can list the visible agent, read the current chat, send verified messages, wait for responses, and delegate batches into separate side chats. Humans can use it directly; other agents can use its versioned NDJSON bridge.

```sh
printf '%s' 'Research this independently and report back' \
  | mbot delegate run 180 --json
```

> [!IMPORTANT]
> **Independent and unofficial.** This project is not affiliated with, endorsed by, sponsored by, or maintained by Meta Platforms, Inc. or the Muse team. “Meta,” “Muse,” and related names and marks belong to their respective owners and are used here only to describe compatibility. This project does not use Meta or Muse logos and does not bypass login, signing, attestation, or platform security.

This project is experimental. Muse's private interfaces and accessibility tree may change between app builds.

## Requirements

- macOS with Muse installed in `/Applications/Muse.app`
- Node.js 22 or newer
- Muse running with the user already signed in for agent, chat, and delegation commands
- Accessibility permission for the compiled `mbot-helper` or its parent terminal/editor

`mbot` does not perform Muse login or create an authenticated session. It operates through the installed app and the session the user has already established. Installation diagnostics and static protocol catalogs can work while signed out, but live UI commands cannot.

## Usage

Install the package globally:

```sh
npm install --global muse-bot-cli
```

Commands use the `mbot <group> <action>` form:

```sh
mbot doctor
mbot capabilities
mbot protocol routes chat. --json
mbot browser commands --json
mbot auth status
mbot ui status
mbot agent current
mbot agents list --json
mbot chat current 10
printf '%s' 'Summarize the current task' | mbot chat ask 120 --json
printf '%s' 'Research this in a fresh chat' | mbot delegate run 180 --json
```

### Commands

```sh
mbot ui request-permission
mbot ui status
mbot ui snapshot --json
mbot agent current
mbot agents list --json
mbot chat current 20 --json
```

The snapshot is bounded and omits secure text fields. `agent current` returns the visible agent name, while `chat current` returns recent messages currently represented in Muse's accessibility tree.

### Delegation

Prompts are accepted on stdin so message text is not exposed in process arguments:

```sh
printf '%s' 'Check whether this workflow works' | mbot chat send --json
mbot chat status --json
mbot chat wait 120 --json
printf '%s' 'Research this independently' | mbot delegate run 180 --json
printf '%s' '["Research option A","Research option B"]' \
  | mbot delegate batch 180 --json
```

`chat send` verifies that Muse rendered the exact user turn. Ask, wait, and delegation commands only report completion after a visible assistant turn. Batch output includes a separate success, response, or error for each job.

### Experimental In-App Bridge

The installed production Muse build does not expose an inspectable WKWebView, so this prototype cannot currently attach to it. The commands below are retained for development or a future Muse build that enables inspection.

Start the loopback broker:

```sh
mbot bridge in-app serve
```

In a second terminal, copy the bootstrap script and evaluate it in the Muse page's Web Inspector console:

```sh
mbot bridge in-app bootstrap | pbcopy
```

The bootstrap locates Muse's existing authenticated RPC context. Muse tokens and Noise material remain inside Muse; only allowlisted request results cross the random-key loopback channel.

Once attached:

```sh
mbot bridge in-app status
mbot sessions list
mbot chat history <session-id> 32
```

## Agent Bridge

`mbot bridge stdio` reads one JSON request per line from stdin and writes one versioned JSON response per non-empty line to stdout.

```sh
printf '%s\n' \
  '{"version":1,"id":"describe","op":"bridge.describe"}' \
  '{"version":1,"id":"routes","op":"protocol.routes","params":{"prefix":"chat."}}' \
  | mbot bridge stdio
```

Requests use this shape:

```json
{"version":1,"id":"request-id","op":"doctor","params":{}}
```

Responses are `{ "version": 1, "id": ..., "ok": true, "result": ... }` or `{ "version": 1, "id": ..., "ok": false, "error": ... }`. Send `bridge.describe` to discover the operations implemented by the current bridge.

## Current Scope

Available now:

- Muse installation, process, metadata, store, and compatibility diagnostics
- Gateway route catalog extraction without executing bundled app code
- Browser-node command schema extraction
- Secret-redacted JSON output
- Versioned NDJSON subprocess bridge
- Native Swift Accessibility helper for the production Muse app
- Current visible agent-name reads
- Structured reads of the current visible chat
- Verified message submission and response polling
- Fresh side-chat and batch delegation
- Agent-facing NDJSON operations for list, read, send, ask, and delegate

Not yet available:

- Direct authenticated private-API access to the production Muse app
- Listing offscreen agents, sessions, or complete server-side chat history
- Push-based chat streams; response events currently use bounded polling
- Dispatching browser-node commands
- Task, event, artifact, or session mutation

The native helper provides working access to the visible production Muse UI. The in-app bridge prototype remains blocked because Muse 4.1 build `1077426479` does not appear as an inspectable application. Direct transport operations remain unavailable or `capture_required`; the CLI does not imitate successful dispatch.

See [docs/protocol.md](docs/protocol.md) for architecture and compatibility details, [docs/native-helper.md](docs/native-helper.md) for production UI access, [docs/bridge.md](docs/bridge.md) for the agent protocol, [docs/grok-parity.md](docs/grok-parity.md) for the capability comparison, [docs/in-app-bridge.md](docs/in-app-bridge.md) for the blocked attachment prototype, and [docs/security.md](docs/security.md) for trust boundaries and disclosure guidance.

## Development

```sh
npm test
npm run check
```

## Disclaimer and Limitation of Liability

This software is provided **“as is” and “as available,” without warranties of any kind**, express or implied. Use it entirely at your own risk.

To the maximum extent permitted by applicable law, the project author and contributors are not liable for any direct, indirect, incidental, special, consequential, or exemplary damages arising from use or misuse of this software. This includes automated actions, inaccurate agent output, account restrictions, data loss, security incidents, service interruption, purchases, messages, or other actions performed through Muse.

You are responsible for reviewing prompts and actions, protecting your account and data, and complying with applicable laws and third-party terms. You should supervise consequential workflows and independently verify agent output before relying on it.

## Trademark or Takedown Concerns

If you represent Meta, the Muse team, or another rights holder and believe this project creates a trademark, copyright, security, or other concern, please [open an issue](https://github.com/ahnafyy/muse-bot-cli/issues/new) or contact [@ahnafyy](https://github.com/ahnafyy) through GitHub.
