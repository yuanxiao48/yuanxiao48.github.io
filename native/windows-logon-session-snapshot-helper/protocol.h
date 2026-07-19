#ifndef WINDOWS_LOGON_SESSION_SNAPSHOT_PROTOCOL_H
#define WINDOWS_LOGON_SESSION_SNAPSHOT_PROTOCOL_H

#include <stddef.h>
#include <stdint.h>

#define SLS1_SCHEMA_VERSION 1u
#define SLS1_MAX_SESSION_COUNT 4096u
#define SLS1_HEADER_BYTES 20u
#define SLS1_LUID_BYTES 8u
#define SLS1_MAX_DOCUMENT_BYTES (SLS1_HEADER_BYTES + (SLS1_MAX_SESSION_COUNT * SLS1_LUID_BYTES))

int sls1_encode(
	uint16_t current_logon_type,
	const uint8_t current_luid[SLS1_LUID_BYTES],
	const uint8_t *sorted_live_luids,
	uint32_t session_count,
	uint8_t *output,
	size_t output_capacity,
	size_t *written);

#endif
