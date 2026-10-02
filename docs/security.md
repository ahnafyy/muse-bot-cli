# Security Policy

## Trust Model

This CLI reads metadata from a locally installed Muse app and its data directories. Muse protocols are private, version-dependent interfaces. Treat changed compatibility fingerprints and newly discovered routes as untrusted until reviewed.

The CLI does not bypass Muse login, attestation, application signing, or platform security. It does not claim that the presence of a data store proves authentication.

## Data Handling

- Diagnostic JSON recursively redacts values under keys that look credential-bearing.
- Preference values, cookies, native tokens, raw protocol frames, conversation content, and account identifiers are not included in diagnostics.
- Credentials must not be supplied through command-line arguments because process listings and shell history may expose them.
- Message and delegation text is accepted through stdin or structured bridge input, never command-line arguments.
- Installed JavaScript catalogs are parsed as text and are not executed.
- Unexpected stdio bridge exceptions return a generic message rather than local paths or exception details.

The compatibility fingerprint contains app versions and code hashes, not credentials or account data.

## In-App Bridge

The in-app bridge is an experimental broker prototype. Live verification found that the tested production Muse WKWebView is not inspectable, so it cannot currently attach to the authenticated page.

The in-app bridge binds to `127.0.0.1` on an ephemeral port and authenticates every request with a random 256-bit session key. Its state file is written under `~/.mbot/` with owner-only permissions. The bootstrap script receives that local key but never receives or returns Muse VM tokens, notary tokens, cookies, or native attestation material.

The broker accepts only reviewed read methods. The first version supports shared-agent and session listing, explicit chat-history reads, and selected task/activity/artifact reads. Destructive or mutating methods are rejected even when Muse supports them.

Any page script running in the attached Muse document can access page memory, so bootstrap only the script emitted by the locally installed `mbot` executable. Stop the broker after use and do not publish its generated bootstrap script while it is active.

## Private Transport

Muse chatbot requests use an attested Noise WebSocket and native token provisioning. Reimplementing the route body without the authenticated handshake is neither functional nor an acceptable shortcut. Direct transport messaging, push events, task APIs, and artifacts remain disabled until that transport can be used through a supported or safely verified bridge. Visible composer submission and bounded response polling are available through the native Accessibility helper and are verified against the resulting UI state.

The browser extension is a server-to-node worker. Its command catalog does not establish that the CLI can dispatch commands to it. Browser dispatch remains unverified.

## Captures and Reports

Before sharing a diagnostic report or protocol capture:

1. Remove cookies, authorization headers, query tokens, native tokens, device identifiers, account identifiers, message text, file contents, and gateway URLs containing credentials.
2. Replace request and event IDs with synthetic values while preserving correlation structure.
3. Keep method names, status codes, framing, parameter field names, and redacted value types when they are needed to reproduce compatibility behavior.
4. Re-run the sensitive-data scan before committing or publishing the fixture.

Do not commit Muse application binaries, bundled proprietary source, raw databases, keychain exports, packet captures, or user content.

## Reporting

Report vulnerabilities privately to the repository owner. Include the CLI version, Muse compatibility fingerprint, minimal reproduction, impact, and a sanitized trace. Do not include working credentials or unrelated user data.