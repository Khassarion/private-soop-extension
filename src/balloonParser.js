/**
 * SOOP 별풍선 내역 페이지(point.sooplive.com/Report/AfreecaBalloonList.asp) 응답 HTML 파서.
 * 서비스 워커에는 DOMParser가 없어서 정규식으로 처리한다. 테이블은 위치가 아니라 헤더
 * 텍스트로 식별한다. 반환값은 시트 이름 → 행 배열이고, 각 행은 해당 시트의 열 순서대로
 * 정규화된 셀 값이다(구매/라이브/동영상/방송국/대결미션/도전미션/도전미션누적).
 */

const TABLE_SPECS = [
  { sheet: '구매', headers: ['구매일', '충전개수', '결제수단', '결제금액', '사용기한'] },
  { sheet: '라이브', headers: ['선물한 별풍선 개수', '목소리 선물 개수', '별풍선을 선물한 스트리머', '선물 일시'] },
  { sheet: '동영상', headers: ['선물한 별풍선 개수', '별풍선을 선물한 스트리머', '선물한 동영상 보기', '선물 일시'] },
  { sheet: '방송국', headers: ['선물한 별풍선 개수', '별풍선을 선물한 스트리머', '선물 일시'] },
  { sheet: '대결미션', headers: ['선물한 별풍선 개수', '별풍선을 후원한 대결미션', '선물 일시'] },
  { sheet: '도전미션', headers: ['상태', '별풍선 개수', '별풍선을 후원한 도전미션 내용', '일시'] },
  { sheet: '도전미션누적', headers: ['도전미션 내용', '총 후원한 별풍선 개수', '미션 결과'] },
];

export function parseBalloonPage(html) {
  const result = {};
  for (const tableHtml of html.match(/<table[\s\S]*?<\/table>/gi) || []) {
    const headers = [...tableHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => cellText(m[1]));
    const spec = TABLE_SPECS.find((s) => sameList(s.headers, headers));
    if (!spec) continue;

    result[spec.sheet] ||= [];
    for (const rowHtml of tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      if (/class=['"]?no_list/i.test(rowHtml)) continue;
      const cells = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length === 0) continue;
      result[spec.sheet].push(toSheetRow(spec.sheet, cells));
    }
  }
  return result;
}

/** "2026-09-21 오후 7:57:21" 과 "2026-10-05 02:15:42" 를 "YYYY-MM-DD HH:mm:ss"(24시간제)로 맞춘다. */
export function normalizeBalloonDate(text) {
  const trimmed = String(text).trim();
  const m = trimmed.match(/^(\d{4}-\d{2}-\d{2})\s+(?:(오전|오후)\s+)?(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return trimmed;
  let hour = Number(m[3]);
  if (m[2] === '오후' && hour !== 12) hour += 12;
  if (m[2] === '오전' && hour === 12) hour = 0;
  return `${m[1]} ${String(hour).padStart(2, '0')}:${m[4]}:${m[5]}`;
}

function toSheetRow(sheet, cells) {
  const text = (i) => cellText(cells[i]);
  const date = (i) => normalizeBalloonDate(cellText(cells[i]));
  switch (sheet) {
    case '구매':
      return [date(0), text(1), text(2), text(3), date(4)];
    case '라이브':
      return [text(0), text(1), text(2), date(3)];
    case '동영상':
      return [text(0), text(1), hrefOf(cells[2]), date(3)];
    case '방송국':
      return [text(0), text(1), date(2)];
    case '대결미션':
      return [text(0), text(1), date(2)];
    case '도전미션':
      return [text(0), text(1), text(2), date(3)];
    case '도전미션누적':
      return [text(0), text(1), text(2)];
    default:
      return cells.map((_, i) => text(i));
  }
}

function cellText(html) {
  return decodeEntities(String(html || '').replace(/<\/?[a-zA-Z][^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function hrefOf(html) {
  return (String(html || '').match(/href=['"]([^'"]+)['"]/i) || [])[1] || '';
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
