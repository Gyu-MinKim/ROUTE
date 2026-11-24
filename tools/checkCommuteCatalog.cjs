'use strict';
const path = require('node:path');
const { newSegmentRound } = require('../lib/segmentRounds');
const { levels } = require('../routes.json');
const file = process.env.ROUTE_SEGMENTS_FILE || path.join(__dirname, '..', 'data', 'commuteSegments.json');

async function check() {
  for (const level of levels) {
    try {
      await newSegmentRound(file, level.round, level);
    } catch (error) {
      throw new Error(`레벨 ${level.id}: ${error.message} (${file}). README의 실제 지도 모드 설치 절차를 확인하세요.`);
    }
  }
  console.log(`확인 완료: ${levels.length}개 레벨에서 완주 가능한 라운드를 생성했습니다.`);
}
check().catch(error => { console.error(error.message); process.exitCode = 1; });
