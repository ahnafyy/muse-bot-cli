# Grok Bot Capability Parity

This matrix compares the locally inspected Grok Bot 0.47.0 architecture with capabilities that can be implemented safely against Muse 4.1 build `1077426479`. It records verified behavior, not route-name speculation.

| Capability | Grok Bot architecture | `mbot` status | Muse implementation |
| --- | --- | --- | --- |
| Native macOS control | `CUGrokBotService` | Available | Swift Accessibility helper |
| Agent discovery | First-party agent modules | Visible UI | `agents list`, `agent current` |
| Chat transcript reads | First-party transcript modules | Visible UI | `chat current` |
| Message submission | First-party chat/RPC modules | Available | Stdin-only keyboard submission with exact-turn verification |
| Response events | First-party RPC/events | Polling | `chat status`, `chat wait`, `chat ask` |
| Job delegation | Node agent coordinator | Available | Fresh Muse side chats via `delegate run` |
| Batch coordination | Node agent coordinator | Available | Per-job `delegate batch` results |
| Machine interface | Unix socket RPC | Available | Versioned NDJSON over stdio |
| Local execution daemon | Local exec daemon | CLI process | Node CLI and native helper subprocess |
| Browser automation | First-party browser integration | Schema only | 26 commands detected; external dispatch unverified |
| Screen capture | ScreenCaptureKit | Permission blocked | Not exposed until Screen Recording is granted and validated |
| Apple Events | AppleEvents | Not used | Deliberately avoided; Accessibility is the control plane |
| Authenticated private RPC | Bundled first-party RPC | Blocked | Muse requires native token provisioning and attested Noise |
| Full session/resource listing | First-party state/RPC | Blocked | Only accessibility-visible state is reported |
| Artifacts/files/tasks | First-party modules | Catalog only | Routes exist, but authenticated dispatch is unavailable |

## Reliability Contract

- Native action success is insufficient: `mbot` verifies the expected user turn before reporting acceptance.
- Delegation completes only after a visible assistant turn follows the submitted user turn.
- Every batch job reports its own response or error.
- Prompt content travels through stdin or an in-process bridge dependency, never argv.
- The CLI does not export Muse credentials or claim private transport support.

## Remaining Boundary

Push subscriptions, offscreen session enumeration, direct browser dispatch, artifacts, and task mutation require a supported authenticated Muse control plane. Accessibility alone cannot reproduce those capabilities honestly.