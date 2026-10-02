# Protocol Notes

## Architecture

Muse exposes two distinct private protocol surfaces:

1. The chatbot control plane uses HTTP-style routes over an attested Noise WebSocket. The desktop app obtains credentials and attestation material through native code.
2. The browser node uses a WebKit script-message bridge and a separate command schema. Catalog presence proves schema availability, not that external dispatch is possible.

The CLI keeps these surfaces separate. It parses installed JavaScript bundles as data and never evaluates them.

## Compatibility

`mbot doctor` computes a compatibility fingerprint from the Muse bundle identifier, app version and build, browser extension version, and selected protocol-bundle hashes. Consumers should treat a changed fingerprint as a compatibility event and rerun discovery before relying on private routes.

The initial tested installation is:

- Bundle: `com.meta.endo`
- Muse: `4.1` build `1077426479`
- Browser extension: `1.0.8`

These values are observations, not hard requirements. Discovery reports other versions instead of silently assuming compatibility.

## Authentication Boundary

The presence of Muse HTTP, WebKit, or preference stores does not prove that an external process can authenticate. The HTTP store currently exposes alternate-service metadata rather than a reusable cookie table. The CLI does not read or print preference values, cookies, native tokens, or credentials.

Direct private-transport messaging requires a supported Muse API or an in-app bridge capable of provisioning the attested transport and remains `capture_required`. The native Accessibility helper separately provides verified message submission through Muse's visible composer.

## Stdio Protocol

The bridge is newline-delimited JSON over stdin/stdout. Requests are handled sequentially to preserve ordering and apply stream backpressure. Blank lines are ignored, malformed lines receive an `invalid_json` response, and one failing request does not terminate the process.

Request `version` may be omitted for version 1 compatibility. An explicitly unsupported version is rejected. Operation errors use stable string codes; unexpected exceptions are not returned verbatim to avoid leaking local paths or sensitive details.

The bridge does not accept credentials in request parameters and does not place sensitive values in process arguments.