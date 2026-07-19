#include "protocol.h"

#include <string.h>

static int supported_logon_type(uint16_t value) {
	return value == 2u || value == 10u || value == 11u || value == 12u;
}

static void write_u16_le(uint8_t *output, uint16_t value) {
	output[0] = (uint8_t)(value & 0xffu);
	output[1] = (uint8_t)((value >> 8) & 0xffu);
}

static void write_u32_le(uint8_t *output, uint32_t value) {
	output[0] = (uint8_t)(value & 0xffu);
	output[1] = (uint8_t)((value >> 8) & 0xffu);
	output[2] = (uint8_t)((value >> 16) & 0xffu);
	output[3] = (uint8_t)((value >> 24) & 0xffu);
}

int sls1_encode(
	uint16_t current_logon_type,
	const uint8_t current_luid[SLS1_LUID_BYTES],
	const uint8_t *sorted_live_luids,
	uint32_t session_count,
	uint8_t *output,
	size_t output_capacity,
	size_t *written) {
	size_t document_bytes;
	uint32_t index;
	int current_found = 0;

	if (written != NULL) *written = 0u;
	if (!supported_logon_type(current_logon_type) || current_luid == NULL || sorted_live_luids == NULL || output == NULL || written == NULL) return 0;
	if (session_count == 0u || session_count > SLS1_MAX_SESSION_COUNT) return 0;
	if (session_count > (SIZE_MAX - SLS1_HEADER_BYTES) / SLS1_LUID_BYTES) return 0;
	document_bytes = SLS1_HEADER_BYTES + ((size_t)session_count * SLS1_LUID_BYTES);
	if (output_capacity < document_bytes) return 0;

	for (index = 0u; index < session_count; index += 1u) {
		const uint8_t *item = sorted_live_luids + ((size_t)index * SLS1_LUID_BYTES);
		if (index > 0u) {
			const uint8_t *previous = item - SLS1_LUID_BYTES;
			if (memcmp(previous, item, SLS1_LUID_BYTES) >= 0) return 0;
		}
		if (memcmp(item, current_luid, SLS1_LUID_BYTES) == 0) current_found = 1;
	}
	if (!current_found) return 0;

	output[0] = 'S';
	output[1] = 'L';
	output[2] = 'S';
	output[3] = '1';
	write_u16_le(output + 4u, SLS1_SCHEMA_VERSION);
	write_u16_le(output + 6u, current_logon_type);
	write_u32_le(output + 8u, session_count);
	memcpy(output + 12u, current_luid, SLS1_LUID_BYTES);
	memcpy(output + SLS1_HEADER_BYTES, sorted_live_luids, (size_t)session_count * SLS1_LUID_BYTES);
	*written = document_bytes;
	return 1;
}
