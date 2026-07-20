#include "protocol.h"

#include <windows.h>
#include <ntsecapi.h>
#include <securitybaseapi.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

static void encode_luid(const LUID *value, uint8_t output[SLS1_LUID_BYTES]) {
	uint32_t low = value->LowPart;
	uint32_t high = (uint32_t)value->HighPart;
	output[0] = (uint8_t)(low & 0xffu);
	output[1] = (uint8_t)((low >> 8) & 0xffu);
	output[2] = (uint8_t)((low >> 16) & 0xffu);
	output[3] = (uint8_t)((low >> 24) & 0xffu);
	output[4] = (uint8_t)(high & 0xffu);
	output[5] = (uint8_t)((high >> 8) & 0xffu);
	output[6] = (uint8_t)((high >> 16) & 0xffu);
	output[7] = (uint8_t)((high >> 24) & 0xffu);
}

static int compare_luid_bytes(const void *left, const void *right) {
	return memcmp(left, right, SLS1_LUID_BYTES);
}

static int write_all(HANDLE output, const uint8_t *bytes, size_t length) {
	size_t offset = 0u;
	if (output == NULL || output == INVALID_HANDLE_VALUE) return 0;
	while (offset < length) {
		DWORD requested = (length - offset) > (size_t)MAXDWORD ? MAXDWORD : (DWORD)(length - offset);
		DWORD written = 0u;
		if (!WriteFile(output, bytes + offset, requested, &written, NULL) || written == 0u) return 0;
		offset += (size_t)written;
	}
	return 1;
}

int main(int argc, char **argv) {
	HANDLE token = NULL;
	DWORD statistics_bytes = 0u;
	PTOKEN_STATISTICS statistics = NULL;
	LUID current_luid;
	NTSTATUS status;
	PSECURITY_LOGON_SESSION_DATA current_session_data = NULL;
	ULONG session_count = 0u;
	PLUID session_luids = NULL;
	uint8_t current_bytes[SLS1_LUID_BYTES];
	uint8_t *live_bytes = NULL;
	uint8_t *document = NULL;
	size_t document_bytes = 0u;
	size_t written = 0u;
	uint16_t current_logon_type;
	ULONG index;
	int exit_code = 1;

	(void)argv;
	if (argc != 1) return 2;
	if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
	if (!GetTokenInformation(token, TokenStatistics, NULL, 0u, &statistics_bytes) && GetLastError() != ERROR_INSUFFICIENT_BUFFER) goto cleanup;
	if (statistics_bytes < sizeof(TOKEN_STATISTICS)) goto cleanup;
	statistics = (PTOKEN_STATISTICS)calloc(1u, statistics_bytes);
	if (statistics == NULL) goto cleanup;
	if (!GetTokenInformation(token, TokenStatistics, statistics, statistics_bytes, &statistics_bytes)) goto cleanup;
	current_luid = statistics->AuthenticationId;

	status = LsaGetLogonSessionData(&current_luid, &current_session_data);
	if (status != 0 || current_session_data == NULL || current_session_data->Size < sizeof(SECURITY_LOGON_SESSION_DATA)) goto cleanup;
	current_logon_type = (uint16_t)current_session_data->LogonType;
	if (!(current_logon_type == 2u || current_logon_type == 10u || current_logon_type == 11u || current_logon_type == 12u)) goto cleanup;

	status = LsaEnumerateLogonSessions(&session_count, &session_luids);
	if (status != 0 || session_count == 0u || session_count > SLS1_MAX_SESSION_COUNT || session_luids == NULL) goto cleanup;
	if ((size_t)session_count > SIZE_MAX / SLS1_LUID_BYTES) goto cleanup;
	live_bytes = (uint8_t *)calloc((size_t)session_count, SLS1_LUID_BYTES);
	if (live_bytes == NULL) goto cleanup;
	for (index = 0u; index < session_count; index += 1u) encode_luid(&session_luids[index], live_bytes + ((size_t)index * SLS1_LUID_BYTES));
	encode_luid(&current_luid, current_bytes);
	qsort(live_bytes, (size_t)session_count, SLS1_LUID_BYTES, compare_luid_bytes);

	document = (uint8_t *)calloc(1u, SLS1_MAX_DOCUMENT_BYTES);
	if (document == NULL) goto cleanup;
	if (!sls1_encode(current_logon_type, current_bytes, live_bytes, session_count, document, SLS1_MAX_DOCUMENT_BYTES, &written)) goto cleanup;
	if (written == 0u || written > SLS1_MAX_DOCUMENT_BYTES) goto cleanup;
	if (!write_all(GetStdHandle(STD_OUTPUT_HANDLE), document, written)) goto cleanup;
	document_bytes = written;
	if (document_bytes == written) exit_code = 0;

cleanup:
	if (document != NULL) free(document);
	if (live_bytes != NULL) free(live_bytes);
	if (session_luids != NULL) LsaFreeReturnBuffer(session_luids);
	if (current_session_data != NULL) LsaFreeReturnBuffer(current_session_data);
	if (statistics != NULL) free(statistics);
	if (token != NULL) CloseHandle(token);
	return exit_code;
}
