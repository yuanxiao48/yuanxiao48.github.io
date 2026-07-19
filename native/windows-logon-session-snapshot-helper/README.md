# Windows logon-session snapshot helper

This Windows-only helper has no arguments and writes one `SLS1` binary snapshot to stdout only after all validation succeeds. It queries only its own token, the current logon-session type, and the existing LSA logon-session LUID identifiers.

The helper never reads or writes files, receives no source or journal data, emits no text diagnostics, and must not be run as part of ordinary builds. `test-protocol.c` exercises only the pure encoder; it does not query Windows identity APIs.

`SLS1` layout: bytes `0..3` are ASCII `SLS1`; `4..5` are schema version `1` as little-endian `uint16`; `6..7` are the current logon type as little-endian `uint16`; `8..11` are the count as little-endian `uint32`; `12..19` are the current canonical LUID; the remainder is a strictly ascending array of canonical 8-byte LUIDs. The exact length is `20 + count * 8`, with `1 <= count <= 4096`.
