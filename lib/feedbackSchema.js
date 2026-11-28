'use strict';

const FEEDBACK_FIELDS = ['evaluation', 'comparison', 'tip'];
const FEEDBACK_SCHEMA = {
  type: 'object',
  properties: {
    evaluation: { type: 'string', minLength: 1, maxLength: 300, description: '플레이 평가. 친근한 한국어 해요체 한두 문장.' },
    comparison: { type: 'string', minLength: 1, maxLength: 300, description: '기록으로 확인한 기준 경로와의 비교. 한두 문장.' },
    tip: { type: 'string', minLength: 1, maxLength: 300, description: '다음 플레이에 적용할 구체적인 조언. 한두 문장.' },
  },
  required: FEEDBACK_FIELDS,
  additionalProperties: false,
};

function feedbackError(code) {
  return Object.assign(new Error(code), { code });
}

function validateFeedback(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== FEEDBACK_FIELDS.length
      || !FEEDBACK_FIELDS.every(key => Object.hasOwn(value, key))) {
    throw feedbackError('gemini_invalid_schema');
  }
  const result = {};
  for (const key of FEEDBACK_FIELDS) {
    const text = typeof value[key] === 'string' ? value[key].trim() : '';
    if (!text || text.length > 300 || !/[가-힣]/u.test(text)
        || text.split(/[.!?。！？]+(?:\s|$)/u).filter(part => part.trim()).length > 2
        || /GEMINI_|API[_ ]KEY|usedTime|usedRes|stamSpent|playerMinusOptimal|gemini_[a-z_]+|시간\/자원\/체력 부족|```/iu.test(text)
        || /(?:합니다|됩니다|입니다|했습니다|었습니다|십시오)[.!?。！？]?(?:\s|$)/u.test(text)) {
      throw feedbackError('gemini_invalid_schema');
    }
    result[key] = text;
  }
  return result;
}

function parseFeedback(text) {
  if (typeof text !== 'string' || !text.trim()) throw feedbackError('gemini_empty_response');
  let value;
  try { value = JSON.parse(text); }
  catch { throw feedbackError('gemini_invalid_json'); }
  return validateFeedback(value);
}

module.exports = { FEEDBACK_SCHEMA, validateFeedback, parseFeedback };
