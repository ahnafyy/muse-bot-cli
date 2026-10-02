# Native Accessibility Helper

## Architecture

The production Muse app does not expose its WKWebView to Web Inspector. `mbot` therefore uses a compiled Swift helper for the operations that macOS exposes through Accessibility.

```text
mbot command
    -> .build/mbot-helper
    -> AXFocusedWindow for com.meta.endo
    -> bounded accessibility tree
    -> semantic agent/chat parser
```

The helper uses AppKit and ApplicationServices only. It does not use AppleScript, modify Muse, read cookies, access the Keychain, or bypass Muse's attested transport.

## Permission

Build and request permission:

```sh
npm run build:native
mbot ui request-permission
```

Enable `mbot-helper`, or the parent editor/terminal that launches it, under **System Settings > Privacy & Security > Accessibility**. Confirm with:

```sh
mbot ui status
```

## Commands

```sh
mbot ui snapshot [max-depth] [max-nodes] --json
mbot agent current [--json]
mbot agents list [--json]
mbot chat current [limit] [--json]
mbot chat status [--json]
mbot chat send [--json]
mbot chat ask [timeout-seconds] [--json]
mbot chat wait [timeout-seconds] [--json]
mbot delegate run [timeout-seconds] [--json]
mbot delegate batch [timeout-seconds] [--json]
```

Snapshots start at Muse's focused window, falling back to the first Muse window. Traversal defaults to bounded depth/node limits, clips long values, and never returns values from `AXSecureTextField` controls.

`agent current` identifies the agent controls adjacent to the visible composer. `chat current` structures visible user and assistant message groups in display order. These selectors are private UI details and must be revalidated after Muse updates.

Message and delegation commands read prompt content from stdin. The helper clears the composer, emits physical Unicode keyboard events, and submits with Return. The Node layer verifies the resulting user and assistant turns before reporting success.

## Limitations

- Only UI represented in the current accessibility tree is readable.
- Virtualized or unloaded history is not available.
- Direct gateway subscriptions and offscreen resource listing remain unavailable.
- Other mutations require a separately reviewed action layer with explicit confirmation and post-action verification.