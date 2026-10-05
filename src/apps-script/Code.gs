function updateMainTable() {
  ensureSheetLayout();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const main = ss.getSheetByName('main');

  const configs = [
    {
      sheet: '구매',
      date: 0,
      columns: [0, 1, 2, 3],
      output: [0, 1, 2, 3]
    },
    {
      sheet: '라이브',
      date: 3,
      columns: [3, 0, 1, 2],
      output: [0, 4, 5, 6]
    },
    {
      sheet: '도전미션',
      date: 3,
      columns: [3, 0, 1, 2],
      output: [0, 7, 8, 9]
    },
    {
      sheet: '대결미션',
      date: 2,
      columns: [2, 0, 1],
      output: [0, 10, 11]
    },
    {
      sheet: '방송국',
      date: 2,
      columns: [2, 0, 1],
      output: [0, 12, 13]
    },
    {
      sheet: '동영상',
      date: 3,
      columns: [3, 0, 1, 2],
      output: [0, 14, 15, 16]
    }
  ];

  const result = [];

  for (const config of configs) {
    const sheet = ss.getSheetByName(config.sheet);
    const values = sheet.getDataRange().getValues();

    // 첫 번째 행은 헤더
    for (let r = 1; r < values.length; r++) {
      const row = values[r];

      // 날짜가 없으면 제외
      if (row[config.date] === '') continue;

      const outputRow = Array(17).fill('');

      for (let i = 0; i < config.columns.length; i++) {
        outputRow[config.output[i]] = row[config.columns[i]];
      }

      result.push(outputRow);
    }
  }

  // 날짜순 정렬
  result.sort((a, b) => {
    return new Date(b[0]) - new Date(a[0]);
  });

  // 기존 데이터 삭제 (이 셀에서 테이블이 시작됨 A1인 경우 1,1임)
  const startRow = 4;
  const startCol = 1;

  const maxRows = main.getMaxRows();
  main
    .getRange(startRow, startCol, maxRows - startRow + 1, 17)
    .clearContent();

  // 결과 기록
  if (result.length > 0) {
    main
      .getRange(startRow, startCol, result.length, 17)
      .setValues(result);
  }
}

// ---------------------------------------------------------------------------
// 확장 프로그램 "별풍선 이력 동기화"의 웹앱 엔드포인트.
// 배포: 배포 > 새 배포 > 유형 "웹 앱" > 실행 사용자 "나" > 액세스 "모든 사용자".
// 스크립트 속성 SYNC_TOKEN에 확장 옵션 페이지의 토큰과 같은 값을 넣는다.
// 이 스크립트는 스프레드시트에 연결(컨테이너)되어 있어야 한다(updateMainTable과 같은 조건).
// ---------------------------------------------------------------------------

// 시트 헤더 행(1행). 실제 시트에 있던 이름과 같다. 이미 값이 있는 칸은 건드리지 않는다.
const SHEET_HEADERS = {
  '구매': ['구매일', '충전개수', '결제수단', '결제금액', '사용기한'],
  '라이브': ['선물한 별풍선 개수', '목소리 선물 개수', '별풍선을 선물한 스트리머', '선물 일시'],
  '동영상': ['선물한 별풍선 개수', '별풍선을 선물한 스트리머', '선물한 동영상 보기', '선물 일시'],
  '방송국': ['선물한 별풍선 개수', '별풍선을 선물한 스트리머', '선물 일시'],
  '대결미션': ['선물한 별풍선 개수', '별풍선을 후원한 대결미션', '선물 일시'],
  '도전미션': ['상태', '별풍선 개수', '별풍선을 후원한 도전미션 내용', '일시'],
  '도전미션누적': ['도전미션 내용', '총 후원한 별풍선 개수', '미션 결과']
};

// main 시트: 1행 합계 라벨, 2행 구분 라벨(열 위치 기준), 3행 헤더. 데이터는 4행부터 쓴다(updateMainTable 참고).
const MAIN_GROUP_LABELS = { 2: '구매', 5: '라이브', 8: '도전미션', 11: '대결미션', 13: '방송국', 15: 'VOD' };
const MAIN_HEADERS = [
  '구매 또는 선물 일시', '충전개수', '결제수단', '결제금액',
  '선물한 별풍선 개수', '목소리 선물 개수', '별풍선을 선물한 스트리머',
  '상태', '별풍선 개수', '별풍선을 후원한 도전미션 내용',
  '선물한 별풍선 개수', '별풍선을 후원한 대결미션',
  '선물한 별풍선 개수', '별풍선을 선물한 스트리머',
  '선물한 별풍선 개수', '별풍선을 선물한 스트리머', '선물한 동영상 보기'
];

/**
 * 필요한 시트가 없으면 만들고, 헤더가 비어 있으면 헤더를 쓴다. 이미 있는 데이터는 건드리지 않는다.
 * doPost(시트에 쓰기 전)와 updateMainTable(main을 채우기 전)에서 호출한다.
 */
function ensureSheetLayout() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  for (const name of Object.keys(SHEET_HEADERS)) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    const headers = SHEET_HEADERS[name];
    const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (firstRow.every((v) => v === '')) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }

  let main = ss.getSheetByName('main');
  if (!main) main = ss.insertSheet('main', 0);
  if (main.getRange(3, 1).getValue() === '') {
    const groupRow = Array(MAIN_HEADERS.length).fill('');
    for (const [col, label] of Object.entries(MAIN_GROUP_LABELS)) groupRow[Number(col) - 1] = label;
    main.getRange(2, 1, 1, MAIN_HEADERS.length).setValues([groupRow]);
    main.getRange(3, 1, 1, MAIN_HEADERS.length).setValues([MAIN_HEADERS]);
  }
  if (main.getRange(1, 1).getValue() === '') main.getRange(1, 1).setValue('합계');
}

const SYNC_TZ = 'Asia/Seoul';
const SYNC_DATE_FMT = 'yyyy-MM-dd HH:mm:ss';

// 열 순서는 확장(src/balloonParser.js)이 보내는 행의 열 순서와 같다.
// dateCols: 날짜로 써야 하는 열, linkCol: '보기' 하이퍼링크 수식을 만들 열(중복 판정에서는 제외).
const SYNC_SHEETS = {
  '구매': { cols: 5, dateCols: [0, 4] },
  '라이브': { cols: 4, dateCols: [3] },
  '동영상': { cols: 4, dateCols: [3], linkCol: 2 },
  '방송국': { cols: 3, dateCols: [2] },
  '대결미션': { cols: 3, dateCols: [2] },
  '도전미션': { cols: 4, dateCols: [3] }
};

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const body = JSON.parse(e.postData.contents);
    const token = PropertiesService.getScriptProperties().getProperty('SYNC_TOKEN');
    if (!token || body.token !== token) {
      return syncJson({ ok: false, error: '토큰이 맞지 않습니다.' });
    }

    ensureSheetLayout();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const rows = body.rows || {};
    const added = {};
    for (const name of Object.keys(SYNC_SHEETS)) {
      added[name] = appendMissingRows(ss.getSheetByName(name), SYNC_SHEETS[name], rows[name] || []);
    }
    const missionsAdded = appendMissingMissions(ss.getSheetByName('도전미션누적'), body.missions || []);

    updateMainTable();
    return syncJson({ ok: true, added: added, missionsUpdated: missionsAdded });
  } catch (err) {
    return syncJson({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function syncJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * 시트에 이미 있는 행과 같은 키(일시·나머지 셀)를 개수 단위로 비교해, 없는 행만 맨 아래에 추가한다.
 * 같은 초에 찍힌 정당한 중복 후원을 잃지 않으려고 집합이 아니라 개수로 센다.
 */
function appendMissingRows(sheet, spec, incoming) {
  if (!sheet || incoming.length === 0) return 0;

  const lastRow = sheet.getLastRow();
  const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, spec.cols).getValues() : [];
  const remaining = {};
  for (const row of existing) {
    const key = syncRowKey(row, spec);
    remaining[key] = (remaining[key] || 0) + 1;
  }

  const toWrite = [];
  for (const row of incoming) {
    const values = syncToSheetValues(row, spec);
    const key = syncRowKey(values, spec);
    if (remaining[key] > 0) {
      remaining[key] -= 1;
      continue;
    }
    toWrite.push(values);
  }

  if (toWrite.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toWrite.length, spec.cols).setValues(toWrite);
  }
  return toWrite.length;
}

/** 도전미션누적: 미션 내용·총 후원·미션 결과가 모두 같은 행이 이미 있으면 건너뛰고, 없으면 추가한다(기존 행은 덮어쓰지 않음). */
function appendMissingMissions(sheet, missions) {
  if (!sheet || missions.length === 0) return 0;

  const lastRow = sheet.getLastRow();
  const existing = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, 3).getValues() : [];
  const remaining = {};
  for (const row of existing) {
    const key = missionKey(row[0], row[1], row[2]);
    remaining[key] = (remaining[key] || 0) + 1;
  }

  const toWrite = [];
  for (const mission of missions) {
    const key = missionKey(mission[0], mission[1], mission[2]);
    if (remaining[key] > 0) {
      remaining[key] -= 1;
      continue;
    }
    toWrite.push([syncText(mission[0]), syncToSheetValue(mission[1]), syncText(mission[2])]);
  }

  if (toWrite.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, toWrite.length, 3).setValues(toWrite);
  }
  return toWrite.length;
}

function missionKey(name, total, result) {
  return [syncText(name), syncNormalizeCell(total, false), syncText(result)].join('|');
}

function syncRowKey(row, spec) {
  const parts = [];
  for (let i = 0; i < spec.cols; i++) {
    if (i === spec.linkCol) continue;
    parts.push(syncNormalizeCell(row[i], spec.dateCols.indexOf(i) >= 0));
  }
  return parts.join('|');
}

/** 시트 값(Date/숫자/문자열)과 확장이 보낸 문자열을 같은 문자열로 맞춘다. */
function syncNormalizeCell(value, isDate) {
  if (value instanceof Date) return Utilities.formatDate(value, SYNC_TZ, SYNC_DATE_FMT);
  if (typeof value === 'number') {
    // 엑셀 시리얼(1900 기준)을 날짜로 본다. 시트 표시 시각 그대로 쓰도록 UTC로 포맷한다.
    if (isDate) return Utilities.formatDate(new Date((value - 25569) * 86400000), 'UTC', SYNC_DATE_FMT);
    return String(value);
  }
  const text = syncText(value);
  if (isDate) {
    const parsed = syncParseKst(text);
    if (parsed) return Utilities.formatDate(parsed, SYNC_TZ, SYNC_DATE_FMT);
  }
  if (isNumericText(text)) return String(Number(text.replace(/,/g, '')));
  return text;
}

/** 확장이 보낸 행을 시트에 쓸 값으로 바꾼다(날짜는 Date, 숫자는 Number, 동영상 열은 HYPERLINK 수식). */
function syncToSheetValues(row, spec) {
  const values = [];
  for (let i = 0; i < spec.cols; i++) {
    const value = row[i];
    if (i === spec.linkCol) {
      const url = syncText(value).replace(/"/g, '""');
      values.push('=HYPERLINK("' + url + '","보기")');
    } else if (spec.dateCols.indexOf(i) >= 0) {
      values.push(syncParseKst(syncText(value)) || syncText(value));
    } else {
      values.push(syncToSheetValue(value));
    }
  }
  return values;
}

function syncToSheetValue(value) {
  const text = syncText(value);
  return isNumericText(text) ? Number(text.replace(/,/g, '')) : text;
}

function syncText(value) {
  return value == null ? '' : String(value).trim();
}

function isNumericText(text) {
  return /^-?\d[\d,]*(\.\d+)?$/.test(text);
}

function syncParseKst(text) {
  const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + '+09:00');
}
