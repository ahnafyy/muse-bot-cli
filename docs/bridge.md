# Stdio Bridge Reference

Start the long-running bridge with:

```sh
mbot bridge stdio
```

The transport is newline-delimited JSON on stdin/stdout. Each non-empty input line produces exactly one response line. Requests are processed sequentially and responses preserve request order.

## Request Envelope

```json
{
  "version": 1,
  "id": "caller-defined-id",
  "op": "protocol.routes",
  "params": { "prefix": "chat." }
}
```

- `version` is optional for version 1 callers. Explicit unknown versions are rejected.
- `id` is a required string or number and is copied to the response.
- `op` is a required operation name.
- `params` is an optional object.

## Response Envelopes

Success:

```json
{"version":1,"id":"caller-defined-id","ok":true,"result":{}}
```

Failure:

```json
{"version":1,"id":"caller-defined-id","ok":false,"error":{"code":"unsupported_operation","message":"..."}}
```

## Operations

| Operation | Parameters | Result |
| --- | --- | --- |
| `bridge.describe` | None | Protocol version and implemented operation descriptors |
| `doctor` | None | Local Muse discovery and compatibility report |
| `capabilities` | None | Available, unavailable, and capture-required feature groups |
| `auth.status` | None | Non-secret local authentication readiness |
| `protocol.routes` | Optional `prefix` string | Installed Muse gateway route catalog |
| `browser.commands` | None | Installed browser-node command names |
| `agents.list` | None | Agents visible in the current Muse window |
| `chat.current` | Optional `limit` | Current visible messages |
| `chat.status` | None | Current execution state and visible message count |
| `chat.send` | Required `message` | Verified message acceptance |
| `chat.ask` | Required `message`, optional `timeout_seconds` | Acceptance and assistant response |
| `delegate.run` | Required `message`, optional `timeout_seconds` | Fresh side-chat result |
| `delegate.batch` | Required `messages`, optional `timeout_seconds` | Per-job side-chat results |

`bridge.describe` is authoritative for the running version. Message bodies are injected as stdin-equivalent input and are never placed in CLI arguments.

## Error Codes

| Code | Meaning |
| --- | --- |
| `invalid_json` | An input line is not valid JSON |
| `invalid_request` | The envelope or parameters have an invalid shape |
| `unsupported_version` | The requested bridge protocol version is unavailable |
| `unsupported_operation` | The requested operation is not implemented |
| `invalid_cli_response` | An internal CLI operation violated its JSON contract |
| `operation_failed` | The underlying CLI operation failed without a more specific error |
| `internal_error` | An unexpected local failure occurred; details are intentionally suppressed |

Malformed requests do not stop the bridge. EOF ends it successfully. Credentials must not be passed through this bridge.