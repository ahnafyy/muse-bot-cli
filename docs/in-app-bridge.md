# Authenticated In-App Bridge

> Experimental and blocked on the tested production build. Muse 4.1 build `1077426479` does not expose its WKWebView in Safari's Develop menu, so the bootstrap cannot be evaluated inside the authenticated page.

## Purpose

Muse provisions gateway credentials and Noise attestation material through native code. The in-app bridge leaves those values inside Muse and sends reviewed operations through the authenticated `HatchRpcContext` already used by the page.

```text
mbot command
    -> authenticated loopback broker
    -> bootstrap inside Muse WKWebView
    -> existing HatchRpcContext.sendRequest
    -> Muse gateway / Noise transport
```

## Starting a Session on an Inspectable Build

1. Start the broker and leave it running:

   ```sh
   mbot bridge in-app serve
   ```

2. In another terminal, place the generated bootstrap on the clipboard:

   ```sh
   mbot bridge in-app bootstrap | pbcopy
   ```

3. Open Web Inspector for the Muse page, paste the script into its console, and evaluate it. The console prints `[mbot bridge] bootstrap installed`.

4. Verify the attachment:

   ```sh
   mbot bridge in-app status
   ```

5. Run read operations:

   ```sh
   mbot agents list --json
   mbot sessions list --json
   mbot chat history <session-id> 32 --json
   ```

Stop the broker with Ctrl-C. Its state file is removed on graceful shutdown.

## Operation Policy

The broker enforces its allowlist before a request reaches Muse. The installed version permits these read methods:

- `shared_agents.list`
- `shared_agents.detail`
- `sessions.list`
- `sessions.get`
- `chat.history`
- `chat.message_get`
- `tasks.list`
- `tasks.runs`
- `activity.list`
- `activity.get`
- `artifacts.list`

The public CLI initially exposes agent listing, session listing, and chat history. Additional read commands can use the same broker after their response contracts are tested.

## Compatibility

The bootstrap discovers a React context value with Muse's `sendRequest` and `ensureLiveConnection` functions. This is a private implementation detail and may change with Muse updates. Run `mbot doctor` after an update and treat a changed fingerprint as requiring bridge revalidation.

The loopback approach depends on the Muse document allowing requests to `http://127.0.0.1` and exposing its WKWebView for inspection. The tested production build fails the inspectability requirement. Attachment therefore fails closed without exposing Muse credentials.

Making the production app inspectable would require cooperation from Muse or modification/re-signing/injection into the app. This project does not alter Muse's signature, bypass attestation, or inject code into its process.