'use strict';

// 대한민국 서울시 / 신분당선 공식 안내를 기준으로 확인한 성인 교통카드 기본요금.
// 이는 최종 여정 운임이 아님: 거리추가, 환승, 타 지역 버스, 신분당선 별도운임 별도 처리 필요.
// 2026-11-24 검토. 업데이트가 필요할 때 출처 페이지를 다시 확인할 것.
const ADULT_CARD_BASE = Object.freeze({
  subway: 1550,
  bus: 1500,       // 서울 간선·지선버스
  walk: 0,
});
const SEOUL_BUS_CARD = Object.freeze({
  '간선': 1500, '지선': 1500, '순환': 1400,
  '마을': 1200, '광역': 3000, '심야': 2500,
});
const SHINBUNDANG_EXTRA = Object.freeze({
  'Sinsa-Gangnam': 700,
  'Gangnam-Jeongja': 1000,
  'Jeongja-Gwanggyo': 1000,
  'Sinsa-Gangnam+Gangnam-Jeongja': 1700,
  'Gangnam-Jeongja+Jeongja-Gwanggyo': 1500,
  'all-three': 2200,
});
const SOURCES = Object.freeze({
  seoul: 'https://news.seoul.go.kr/traffic/traffic_price',
  bus: 'https://sftc.seoul.go.kr/seoul/mulga/main/contents.do?menuNo=200022',
  subway: 'https://sftc.seoul.go.kr/seoul/mulga/main/contents.do?menuNo=200021',
  shinbundang: 'https://www.shinbundang.co.kr/dxline/dxline4_1.jsp',
});

function busBaseForTypes(types) {
  const known = [...new Set((Array.isArray(types) ? types : []).filter(x => Object.hasOwn(SEOUL_BUS_CARD, x)))];
  // 여러 버스의 요금은 환승 요금 계산이 필요하므로 단일 기본요금으로 취급하지 않는다.
  return known.length === 1 ? SEOUL_BUS_CARD[known[0]] : null;
}

// Masks follow the ordered Shinbundang sections, from Sinsa to Gwanggyo.
const PREMIUM_BY_MASK = [0, SHINBUNDANG_EXTRA['Sinsa-Gangnam'],
  SHINBUNDANG_EXTRA['Gangnam-Jeongja'], SHINBUNDANG_EXTRA['Sinsa-Gangnam+Gangnam-Jeongja'],
  SHINBUNDANG_EXTRA['Jeongja-Gwanggyo'], null,
  SHINBUNDANG_EXTRA['Gangnam-Jeongja+Jeongja-Gwanggyo'], SHINBUNDANG_EXTRA['all-three']];

function shinbundangSections(stationPath) {
  const { network } = require('./subwayNetwork');
  const line = network.lines.S.stationIds;
  const first = line.indexOf(stationPath[0]), last = line.indexOf(stationPath.at(-1));
  const gangnam = line.indexOf('s2_loop_222'), jeongja = line.indexOf('sb_k230');
  const low = Math.min(first, last), high = Math.max(first, last);
  if (low < 0 || low === high || gangnam < 0 || jeongja <= gangnam) return null;
  return (low < gangnam ? 1 : 0) | (low < jeongja && high > gangnam ? 2 : 0) | (high > jeongja ? 4 : 0);
}

module.exports = { PREMIUM_BY_MASK, shinbundangSections, ADULT_CARD_BASE, SEOUL_BUS_CARD, SHINBUNDANG_EXTRA, SOURCES, busBaseForTypes };
