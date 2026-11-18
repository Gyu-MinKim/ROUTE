# ROUTE 함수 정리

구현된 함수를 파일별로, 파일 안에서는 역할별로 묶어 정리한다.

| 파일 | 역할 |
| --- | --- |
| [`lib/engine.js`](../lib/engine.js) | 게임 규칙과 계산 |
| [`server.js`](../server.js) | 상태 관리, 판정, API |
| [`public/game.js`](../public/game.js) | 화면과 조작 |
| [`public/ui.js`](../public/ui.js) | 접근성 |

발표에서 가장 중요한 함수는 `solveOptimal`(최적 경로 탐색), `quote`(요금·환승), `staminaCost`(체력), `POST /api/simulate/step`(서버 판정) 네 가지다.

## 1. 게임 엔진 `lib/engine.js`

### 지도 생성

| 함수 | 설명 |
| --- | --- |
| `rnd`, `shuffle` | 무작위 숫자 생성, 배열 섞기 |
| `roundParams` | 라운드별 지도 크기, 자금, 시간 여유, 버스 등장, 도보 불가 비율 결정 |
| `describeRound` | 이전 라운드 대비 바뀐 점을 문장으로 생성 |
| `edgeTimes` | 거리로 수단별 이동 시간 계산, 비 오는 날 시간 증가 반영 |
| `buildGraph` | 역(노드)과 구간(간선)을 격자로 배치하고 구간별 수단 결정 |
| `other` | 간선의 반대쪽 역 반환 |
| `hopDistance` | BFS로 출발-도착 칸 수 계산 |
| `newRound` | 한 판 생성. 풀 수 있는지 검사하고 사건 시각, 심부름 역, 제한 시간 결정 |

### 이동 규칙

| 함수 | 설명 |
| --- | --- |
| `quote` | 한 번 이동의 시간·요금·환승 여부 계산 (환승이면 무료, +3분) |
| `nextRem` | 이동 후 남은 환승 가능 시간 계산 |
| `staminaCost` | 수단별 체력 소모 계산 (도보가 가장 큼, 부상 시 2배) |
| `stamUnits` | 탐색용으로 체력을 5 단위로 묶음 |
| `timeAt` | 버스 지연, 지하철 중단 등 사건을 반영한 이동 시간 |

### 최적 경로 탐색

| 함수 | 설명 |
| --- | --- |
| `Heap` | 직접 구현한 최소 힙 (`push`, `pop`) |
| `solveOptimal` | 다익스트라. 돈·환승·체력·심부름 조건을 지키며 가장 빨리 도착하는 경로 탐색 |

### 평가

| 함수 | 설명 |
| --- | --- |
| `gradeOf` | 효율로 A+~D 등급 산출 |
| `levelGoals`, `resGoals` | 기준 경로로부터 별 목표(목표 시간, 돈 또는 체력 절약) 결정 |
| `evalGoals` | 끝난 판의 별 개수 판정 |
| `divergenceHint` | 내 경로와 기준 경로가 처음 갈라진 지점으로 힌트 생성 |

## 2. 서버 `server.js`

### 기록 저장

| 함수 | 설명 |
| --- | --- |
| `readHistory`, `appendHistory` | 결과를 JSON 파일에 읽고 쓰기 (최근 500건) |

### 상태와 판정

| 함수 | 설명 |
| --- | --- |
| `quotesFor` | 현재 역에서 갈 수 있는 모든 이동의 견적 계산 |
| `eventView` | 사건 정보를 화면용으로 변환. 시각 미상 사건은 시작 전까지 시각 숨김 |
| `publicState` | 브라우저에 보낼 게임 상태 생성 |
| `canMove` | 남은 시간·돈·체력으로 움직일 수 있는 칸이 있는지 확인 |
| `finish` | 판 종료, 결과(별, 등급, 효율, 힌트) 생성, 기록 저장 |
| `openSession` | 새 게임 세션 생성 |

### 일주일 모드

| 함수 | 설명 |
| --- | --- |
| `weekScenario` | 그날 상황 생성 (전날 지각, 우산, 친구 도움, 저금 반영) |
| `weekView` | 일주일 진행 상황과 금요일 엔딩을 화면용으로 생성 |

### API

| 경로 | 설명 |
| --- | --- |
| `GET /api/routes` | 수단, 캐릭터, 레벨, 캠페인 목록 |
| `GET /api/history` | 전체 플레이 수, 클리어 수, 최고 라운드 |
| `POST /api/simulate/start` | 게임 시작 |
| `POST /api/simulate/step` | 한 칸 이동. 입력 검증과 판정 |
| `POST /api/simulate/retry` | 같은 지도로 재도전 |
| `POST /api/simulate/giveup` | 포기 |
| `POST /api/week/start` | 일주일 모드 시작 |
| `POST /api/week/next` | 오늘 결과 확정, 다음 날로 진행 |

## 3. 화면 `public/game.js`

| 묶음 | 함수 | 설명 |
| --- | --- | --- |
| 공통 도구 | `$`, `$$`, `sleep`, `won`, `escapeHtml`, `syncUI` | 요소 찾기, 대기, 금액 표시, 특수문자 처리, 화면 갱신 알림 |
| 공통 도구 | `store`, `sess` | localStorage, sessionStorage 안전하게 읽고 쓰기 |
| 공통 도구 | `api` | 서버 요청과 오류 처리 |
| 설정·기록 | `applySettings`, `openSettings` | 다크 모드·애니메이션 설정 적용, 설정 창과 기록 초기화 |
| 설정·기록 | `refreshStats` | 플레이 횟수 표시 |
| 설정·기록 | `progress`, `unlocked` | 레벨 별점 읽기, 해금 판단 |
| 창·화면 전환 | `modal`, `closeModal`, `notify` | 팝업 창과 알림 |
| 창·화면 전환 | `confirmNewGame`, `goHome`, `show` | 새 게임 확인, 화면 전환 |
| 지도 조작 | `setVB`, `clampVB`, `svgPoint`, `zoomTo`, `zoomBy` | 확대·축소와 이동 (휠, 드래그, 더블클릭 이벤트 포함) |
| 지도 조작 | `mobile`, `setCollapsed`, `initPanels` | 모바일 패널 접기·펴기 |
| 지도 그리기 | `makeDeco` | 배경 장식(도로 등) |
| 지도 그리기 | `eb`, `adjacent`, `ln` | 간선 찾기, 인접 역 찾기, 선 그리기 |
| 지도 그리기 | `render`, `moveMarker` | SVG 지도 그리기, 현재 위치 이동 애니메이션 |
| 게임 진행 | `updateHud`, `updateFooter` | 남은 시간·돈·체력 표시 |
| 게임 진행 | `placeModes`, `moveUnavailable` | 수단 카드 표시, 이동 불가 이유 안내 |
| 게임 진행 | `missionSub`, `evEffect`, `goalTexts`, `goalsHtml` | 미션, 사건, 별 목표 문구 |
| 게임 진행 | `startRound`, `moveBy` | 판 시작·재도전, 이동 요청 (클릭, 키보드 1·2·3 포함) |
| 결과 | `onRoundEnd` | 별, 등급, 효율, 힌트 표시와 별점 저장 |
| 결과 | `nextLabel`, `nextRound` | 다음 라운드·다음 날 진행 |
| 결과 | `routeRow`, `showCompare` | 내 경로와 기준 경로 비교 |
| 결과 | `replay`, `setReplayBtn` | 기준 경로 재생, 일시정지 |
| 튜토리얼 | `maybeTutorial`, `runTutorial`, `endTutorial` | 첫 판 4단계 안내 |
| 레벨 화면 | `loadLevels`, `renderLevelGrid` | 레벨 목록 불러오기, 별·잠김 타일 그리기 |
| 레벨 화면 | `openLevels`, `openLevelCard` | 레벨 선택 화면, 레벨 소개 창 |
| 일주일 모드 | `showWeek`, `weekLogHtml`, `weekNext`, `weekErr` | 요일 안내, 기록, 다음 날 진행, 오류 처리 |
| 노선도 | `metroHTML` | 실제 1·4·7호선 노선도 |
| 노선도 | `roundSubwayHTML` | 이번 판 지하철 구간 |
| 노선도 | `renderSubway`, `bare` | 노선도 창 그리기, 역 이름의 '역' 제거 |

## 4. 접근성 `public/ui.js`

| 함수 | 설명 |
| --- | --- |
| `focusDialog`, `releaseDialog` | 창이 열리면 키보드 포커스를 창 안에 가두고, 닫히면 원래 위치로 복귀 |
| `closeSubway` | 노선도 창 닫기 |
| `sync` | 화면 상태에 맞게 버튼과 스크린리더 안내 갱신 |
| `popstate`, Esc 처리 | 뒤로가기와 Esc 키 처리 |
