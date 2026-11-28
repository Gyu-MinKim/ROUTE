'use strict';

// Log only allowlisted metadata: never error.message, credentials, request URLs,
// gameplay payloads, generated text, headers, or full SDK error objects.
function coachConfiguration() {
  const model = process.env.GEMINI_MODEL?.trim();
  return {
    apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    modelConfigured: Boolean(model),
    model: /^(?:models\/)?gemini-[a-z0-9.-]{1,80}$/i.test(model || '') ? model : 'unset_or_custom',
  };
}

const ownCodes = new Set([
  'gemini_not_configured', 'gemini_empty_response', 'gemini_invalid_json',
  'gemini_invalid_schema', 'local_rate_limit',
]);
const upstreamReasons = new Set([
  'API_KEY_INVALID', 'API_KEY_EXPIRED', 'API_KEY_SERVICE_BLOCKED',
  'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED',
  'SERVICE_DISABLED', 'BILLING_DISABLED', 'CONSUMER_INVALID',
]);

function coachFailure(error) {
  if (ownCodes.has(error?.code)) return { reason: error.code };
  let detail;
  try { detail = JSON.parse(error?.message).error; } catch { /* Not a JSON API error. */ }
  const status = Number(error?.status ?? detail?.code);
  const result = Number.isInteger(status) && status >= 400 && status <= 599 ? { status } : {};
  const reason = detail?.details?.find(item => upstreamReasons.has(item.reason))?.reason;
  if (reason) return { ...result, reason };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return { ...result, reason: 'timeout' };
  if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') return { reason: 'sdk_unavailable' };
  if (/minimum allowed deadline|deadline .*too short/i.test(detail?.message || '')) return { ...result, reason: 'deadline_too_short' };
  if (status === 429) return { ...result, reason: 'upstream_rate_limit' };
  if (status === 401 || status === 403) return { ...result, reason: 'authentication_or_permission' };
  if (status === 404) return { ...result, reason: 'model_or_endpoint_not_found' };
  if (status >= 500) return { ...result, reason: 'upstream_unavailable' };
  if (status >= 400) return { ...result, reason: 'upstream_rejected_request' };
  if (error?.name === 'TypeError') return { reason: 'network_error' };
  return { reason: 'unexpected_error' };
}

function logCoach(event, { requestId, elapsedMs, source, error, envFile, finishReason } = {}) {
  const metadata = { event, ...coachConfiguration() };
  if (typeof requestId === 'string' && /^[a-f0-9-]{36}$/.test(requestId)) metadata.requestId = requestId;
  if (Number.isFinite(elapsedMs)) metadata.elapsedMs = elapsedMs;
  if (['gemini', 'fallback'].includes(source)) metadata.source = source;
  if (['loaded', 'absent', 'loader_unavailable'].includes(envFile)) metadata.envFile = envFile;
  if (['STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER'].includes(finishReason)) metadata.finishReason = finishReason;
  if (error) Object.assign(metadata, coachFailure(error));
  (error ? console.warn : console.info)('[ROUTE COACH]', JSON.stringify(metadata));
}

module.exports = { coachConfiguration, coachFailure, logCoach };
