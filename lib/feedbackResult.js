'use strict';

const { validateFeedback } = require('./feedbackSchema');
const MODES = { walk: '도보', bus: '버스', subway: '지하철' };

function failureSummary(session) {
  if (session.result.status === 'success') return null;
  if (session.result.usedTime > session.limit) return '제한 시간 안에 도착하지 못했어요.';
  if (session.result.reason === '포기했어요.') return '이번에는 도착하기 전에 도전을 멈췄어요.';
  const blocked = session.blockedBy;
  if (Array.isArray(blocked) && blocked.length && blocked.every(Array.isArray)) {
    const shared = ['time', 'fare', 'stamina'].filter(key => blocked.every(reasons => reasons.includes(key)));
    if (shared.length === 1) return {
      time: '남은 시간 안에 이동할 수 있는 다음 구간이 없었어요.',
      fare: '남은 교통비로 이용할 수 있는 다음 이동이 없었어요.',
      stamina: '남은 체력으로 이어갈 수 있는 다음 이동이 없었어요.',
    }[shared[0]];
    return '남은 조건으로는 다음 구간을 이어갈 수 없었어요.';
  }
  return '이번에는 목적지까지 도착하지 못했어요.';
}

function feedbackResult(session) {
  const { result, graph, persona, maxStamina } = session;
  const station = id => graph.nodes[id].name;
  const route = steps => steps.map(({ from, to, mode, time, cost, stamina, transfer }) => ({
    from: station(from), to: station(to), mode, minutes: time, fareWon: cost, staminaUsed: stamina, transfer,
  }));
  const staminaLeft = spent => persona ? maxStamina - spent : null;
  const opt = result.optimal;
  const optimal = opt && {
    criterion: session.errand
      ? '교통비·체력 한도 내 심부름 경유 최단 시간 경로'
      : '교통비·체력 한도 내 최단 시간 경로',
    steps: route(opt.steps), minutes: opt.time, fareWon: opt.cost,
    staminaLeft: staminaLeft(opt.steps.reduce((total, step) => total + step.stamina, 0)),
  };
  const player = {
    start: station(session.start), destination: station(session.dest), lastStation: station(session.cur),
    steps: route(session.path), minutes: result.usedTime, fareWon: result.usedRes,
    staminaLeft: staminaLeft(session.stamSpent),
  };
  const event = session.event;
  return {
    mode: session.mode, round: session.round, levelId: session.levelId,
    status: result.status, failureReason: failureSummary(session),
    blockedMoveConstraints: session.blockedBy,
    stars: result.stars, grade: result.grade,
    limits: {
      minutes: session.limit, fareWon: session.resources, startingStamina: persona ? maxStamina : null,
      subwayDisabled: Boolean(session.scenario?.mods?.subwayOff),
      busPresentOnMap: graph.edges.some(edge => edge.opts.bus != null),
    },
    goals: session.goals, goalResults: result.hit, checks: result.checks,
    event: event ? {
      title: event.title, mode: event.mode, startsAtMinute: event.at,
      startedByRoundEnd: session.used >= event.at, suspended: Boolean(event.off), timeMultiplier: event.mul ?? null,
    } : null,
    mission: session.errand ? {
      station: station(session.errand.node), goal: session.errand.goal, completed: result.errandDone,
    } : null,
    player, optimal: optimal ?? null,
    playerMinusOptimal: optimal ? {
      minutes: player.minutes - optimal.minutes,
      fareWon: player.fareWon - optimal.fareWon,
      staminaLeft: persona ? player.staminaLeft - optimal.staminaLeft : null,
    } : null,
  };
}

function routeAdvice({ status, player, optimal }) {
  if (!optimal) return {
    comparison: '이번 결과에는 비교할 기준 경로가 없어 구간별 차이는 살펴보지 못했어요.',
    tip: '다음에는 이동 전에 남은 시간과 이용 가능한 수단을 먼저 살펴보세요.',
  };
  if (!player.steps.length) return {
    comparison: '아직 이동 기록이 없어 구간별 선택을 비교하기 어려워요.',
    tip: '경로 비교에서 출발역의 첫 이동과 수단을 확인하고 다시 도전해 보세요.',
  };
  const same = (a, b) => a && b && a.from === b.from && a.to === b.to && a.mode === b.mode;
  const index = player.steps.findIndex((step, i) => !same(step, optimal.steps[i])
    || step.minutes > optimal.steps[i]?.minutes);
  if (index === -1 && (status !== 'success' || player.steps.length === optimal.steps.length)) return {
    comparison: status === 'success'
      ? '선택한 이동 순서와 교통수단이 기준 경로와 같아요.'
      : '지금까지의 이동 순서와 수단은 기준 경로의 앞부분과 같아요. 도착 전이라 전체 효율을 비교하지는 않았어요.',
    tip: status === 'success'
      ? '지금의 선택을 기억해 두고 다음에도 갈림길에서 시간과 요금의 균형을 살펴보세요.'
      : '경로 비교에서 마지막으로 도착한 역 다음의 이동과 수단을 확인해 보세요.',
  };
  const chosen = player.steps[index < 0 ? player.steps.length - 1 : index];
  const reference = optimal.steps.find(step => step.from === chosen.from && step.to === chosen.to)
    || optimal.steps.find(step => step.from === chosen.from);
  if (reference && MODES[chosen.mode] && MODES[reference.mode]) {
    const slower = chosen.to === reference.to && chosen.minutes > reference.minutes;
    return {
      comparison: slower
        ? `${chosen.from} → ${chosen.to} 구간의 ${MODES[chosen.mode]} 이동은 기준 경로의 ${MODES[reference.mode]} 이동보다 ${chosen.minutes - reference.minutes}분 더 걸렸어요.`
        : `${chosen.from} → ${chosen.to} 구간에서 ${MODES[chosen.mode]} 이동을 선택했어요. 기준 경로는 ${reference.from} → ${reference.to} 구간에 ${MODES[reference.mode]} 이동을 이용해요.`,
      tip: `같은 지도에 다시 도전할 때 ${reference.from} → ${reference.to} 구간의 ${MODES[reference.mode]} 선택을 살펴보세요.`,
    };
  }
  return {
    comparison: '기준 경로와 다른 이동 선택이 있어요. 경로 비교에서 처음 달라지는 지점을 살펴볼 수 있어요.',
    tip: '같은 지도에 다시 도전할 때 처음 달라진 구간의 이동 수단부터 비교해 보세요.',
  };
}

// Keep engine verdicts authoritative without trying to infer mission coverage
// from generated prose. Replace, rather than append, so evaluation stays within
// two sentences and applying this guard twice does not duplicate anything.
function completeObjectiveFeedback(gameResult, feedback) {
  const { mission, goals, goalResults, status, failureReason, optimal, stars } = gameResult;
  const arrived = status === 'success';
  const missed = [];
  if (goals && goalResults && arrived) {
    // On errand levels hit.time is the errand verdict, not a time threshold.
    if (!goals.errand && goalResults.time === false) missed.push(`목표 시간 ${goals.time}분 이내 도착`);
    if (goalResults.res === false) missed.push(goals.kind === 'money'
      ? `교통비 ${goals.max}원 이하 사용`
      : `체력 ${goals.max} 이하 소모`);
  }
  const missedArrival = goals && goalResults?.arrive === false;
  if (!mission && !missed.length && !missedArrival) return validateFeedback(feedback);

  const corrected = { ...feedback };
  const arrival = arrived ? '목적지까지 잘 도착했어요.'
    : failureReason || '이번에는 목적지까지 도착하지 못했어요.';
  let assessment;
  if (mission) {
    const task = `${mission.station}에서 ‘${mission.goal}’ 심부름`;
    assessment = mission.completed === true
      ? `${arrived ? '' : '그래도 '}${task}을 마친 점은 좋았어요`
      : mission.completed === false
        ? `${task}은 아직 완료하지 못했어요`
        : `${task}의 완료 여부는 확인하지 못했어요`;
    if (missed.length) assessment += `, 다만 ${missed.join(' · ')} 목표는 놓쳤어요`;
  } else {
    assessment = missed.length
      ? `추가 목표인 ${missed.join(' · ')} 조건은 달성하지 못했어요`
      : '레벨 목표는 목적지 도착까지 마쳐야 달성으로 인정돼요';
  }
  corrected.evaluation = `${arrival} ${assessment}.`;

  if (mission?.completed === false) {
    corrected.comparison = optimal
      ? '기준 경로는 심부름까지 수행하는 조건이라, 시간이나 교통비만으로 이번 경로가 더 효율적이었다고 볼 수는 없어요.'
      : '이번에는 심부름을 마치지 않아 전체 미션을 달성한 경로로 평가할 수는 없어요.';
    corrected.tip = `다음에는 ${mission.station}을 경유하도록 이동 순서를 먼저 확인하고, 심부름 뒤 목적지까지 이어 가 보세요.`;
  } else if (mission && missedArrival && Number.isInteger(stars)) {
    corrected.comparison = `목적지 도착까지 마치지 못해 이번 레벨 별점은 ${stars}개예요. 심부름 수행 여부와 목적지 도착은 구분해서 살펴봐야 해요.`;
  }
  if (mission?.completed !== false && missed.length) {
    corrected.tip = !goals.errand && goalResults.time === false
      ? `다음에는 목표 시간인 ${goals.time}분 안에 도착하도록 갈림길의 예상 이동 시간을 먼저 비교해 보세요.`
      : goals.kind === 'money'
        ? `다음에는 교통비를 ${goals.max}원 이하로 쓰도록 이동 전에 구간 요금과 남은 예산을 확인해 보세요.`
        : `다음에는 체력 소모를 ${goals.max} 이하로 맞추도록 이동 전에 필요한 체력을 확인해 보세요.`;
  }
  return validateFeedback(corrected);
}

function basicFeedback(gameResult) {
  const { status, failureReason, player, limits, blockedMoveConstraints } = gameResult;
  const feedback = {
    evaluation: status === 'success'
      ? '목적지까지 잘 도착했어요! 주어진 조건 안에서 끝까지 길을 이어 간 점이 좋아요.'
      : failureReason || '이번에는 목적지까지 도착하지 못했어요.',
    ...routeAdvice(gameResult),
  };
  if (status !== 'success') {
    const shared = key => blockedMoveConstraints?.length
      && blockedMoveConstraints.every(reasons => reasons.includes(key));
    if (player.minutes > limits?.minutes || shared('time')) {
      feedback.tip = '다음에는 갈림길에서 예상 이동 시간과 남은 시간을 먼저 비교해 보세요.';
    } else if (shared('fare')) {
      feedback.tip = '다음에는 이동 수단을 고를 때 구간 요금과 남은 교통비를 먼저 확인해 보세요.';
    } else if (shared('stamina')) {
      feedback.tip = '다음에는 이동 전에 필요한 체력과 남은 체력을 먼저 비교해 보세요.';
    }
  }
  return completeObjectiveFeedback(gameResult, feedback);
}

module.exports = { feedbackResult, basicFeedback, completeObjectiveFeedback };
