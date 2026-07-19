#include "protocol.h"

#include <assert.h>
#include <string.h>

static void luid(uint8_t output[SLS1_LUID_BYTES], uint8_t last) {
	memset(output, 0, SLS1_LUID_BYTES);
	output[SLS1_LUID_BYTES - 1u] = last;
}

static void fill_sorted(uint8_t *output, uint32_t count) {
	uint32_t index;
	for (index = 0u; index < count; index += 1u) {
		uint8_t *item = output + ((size_t)index * SLS1_LUID_BYTES);
		memset(item, 0, SLS1_LUID_BYTES);
		item[4] = (uint8_t)(((index + 1u) >> 24) & 0xffu);
		item[5] = (uint8_t)(((index + 1u) >> 16) & 0xffu);
		item[6] = (uint8_t)(((index + 1u) >> 8) & 0xffu);
		item[7] = (uint8_t)((index + 1u) & 0xffu);
	}
}

int main(void) {
	uint8_t current[SLS1_LUID_BYTES];
	uint8_t sessions[3u * SLS1_LUID_BYTES];
	uint8_t maximum_sessions[SLS1_MAX_SESSION_COUNT * SLS1_LUID_BYTES];
	uint8_t document[SLS1_MAX_DOCUMENT_BYTES];
	size_t written = 99u;

	luid(current, 2u);
	luid(sessions, 1u);
	luid(sessions + SLS1_LUID_BYTES, 2u);
	luid(sessions + (2u * SLS1_LUID_BYTES), 3u);
	assert(sls1_encode(2u, current, sessions, 3u, document, sizeof(document), &written) == 1);
	assert(written == SLS1_HEADER_BYTES + (3u * SLS1_LUID_BYTES));
	assert(memcmp(document, "SLS1", 4u) == 0);
	assert(document[4] == 1u && document[5] == 0u);
	assert(document[6] == 2u && document[7] == 0u);
	assert(document[8] == 3u && document[9] == 0u && document[10] == 0u && document[11] == 0u);
	assert(memcmp(document + 12u, current, SLS1_LUID_BYTES) == 0);
	fill_sorted(maximum_sessions, SLS1_MAX_SESSION_COUNT);
	memcpy(current, maximum_sessions + ((size_t)(SLS1_MAX_SESSION_COUNT - 1u) * SLS1_LUID_BYTES), SLS1_LUID_BYTES);
	assert(sls1_encode(10u, current, maximum_sessions, SLS1_MAX_SESSION_COUNT, document, sizeof(document), &written) == 1);
	assert(written == SLS1_MAX_DOCUMENT_BYTES);
	assert(sls1_encode(2u, current, sessions, 0u, document, sizeof(document), &written) == 0 && written == 0u);
	assert(sls1_encode(2u, current, sessions, SLS1_MAX_SESSION_COUNT + 1u, document, sizeof(document), &written) == 0 && written == 0u);
	assert(sls1_encode(3u, current, sessions, 3u, document, sizeof(document), &written) == 0 && written == 0u);
	assert(sls1_encode(2u, current, sessions, 3u, document, SLS1_HEADER_BYTES, &written) == 0 && written == 0u);
	luid(sessions + SLS1_LUID_BYTES, 1u);
	assert(sls1_encode(2u, current, sessions, 3u, document, sizeof(document), &written) == 0 && written == 0u);
	luid(sessions + SLS1_LUID_BYTES, 2u);
	luid(current, 9u);
	assert(sls1_encode(2u, current, sessions, 3u, document, sizeof(document), &written) == 0 && written == 0u);
	return 0;
}
