/**
 * 유튜브에 올라간 영상과 Soop 다시보기 파일을 짝짓는 순수 함수들.
 * - 어느 다시보기인가: 영상 설명의 Soop 다시보기 링크(…/player/{titleNo})
 * - 몇 번째 파일인가: 제목 앞머리의 "[날짜 (n/max)]" (파일이 하나뿐이면 "[날짜]" → 1/1)
 * n은 다시보기의 files 배열 순서(1부터)이며 file_order와는 다를 수 있다.
 */

const VOD_LINK_RE = /sooplive\.com\/player\/(\d+)/;
const TITLE_PART_RE = /^\s*\[[^\]]*?\((\d+)\/(\d+)\)\]/;
const TITLE_SINGLE_RE = /^\s*\[[^\]()]+\]/;
const TITLE_DATE_RE = /^\s*\[(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일(?:\s*\((\d+)\/(\d+)\))?\]/;
const BROADCAST_START_RE = /방송\s*시간:\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/;

/** 제목 앞머리 "[YYYY년 M월 D일 (n/max)]"의 정렬 키 { date: YYYYMMDD 숫자, n }. 날짜가 없으면 null. */
export function parseTitleDate(title) {
  const m = TITLE_DATE_RE.exec(title || '');
  if (!m) return null;
  const date = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  const n = m[4] ? Number(m[4]) : 1;
  return { date, n };
}

/** 설명의 "방송 시간: YYYY-MM-DD HH:mm:ss ~ …" 시작 시각(ms epoch). vodFileInfo.js의 buildFileMeta가 쓰는 형식과 맞춘다. 없으면 null. */
export function parseBroadcastStart(description) {
  const m = BROADCAST_START_RE.exec(description || '');
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

/** 영상 하나에서 { vodId(soop), n, max }를 뽑는다. 못 뽑으면 null. */
export function parseUpload(video) {
  const link = VOD_LINK_RE.exec(video.description || '');
  if (!link) return null;
  const title = video.title || '';
  const part = TITLE_PART_RE.exec(title);
  if (part) return { vodId: link[1], n: Number(part[1]), max: Number(part[2]) };
  if (TITLE_SINGLE_RE.test(title)) return { vodId: link[1], n: 1, max: 1 };
  return null;
}

/** 유튜브 영상 목록 → Map<soopVideoId, Map<n, {youtubeId,title,privacy,max}[]>> */
export function indexYoutubeUploads(youtubeVideos) {
  const index = new Map();
  for (const video of youtubeVideos) {
    const parsed = parseUpload(video);
    if (!parsed) continue;
    if (!index.has(parsed.vodId)) index.set(parsed.vodId, new Map());
    const byN = index.get(parsed.vodId);
    if (!byN.has(parsed.n)) byN.set(parsed.n, []);
    byN.get(parsed.n).push({
      youtubeId: video.videoId,
      title: video.title,
      privacy: video.privacy || '',
      max: parsed.max,
    });
  }
  return index;
}

/** 한 다시보기의 파일별 업로드 여부/링크. 모든 파일이 올라갔으면 complete. */
export function matchVodFiles(videoId, files, index) {
  const byN = index.get(String(videoId));
  const result = files.map((file, i) => {
    const uploads = byN?.get(i + 1) || [];
    return {
      n: i + 1,
      fileOrder: Number(file.file_order),
      uploaded: uploads.length > 0,
      youtubeUrl: uploads[0] ? `https://youtu.be/${uploads[0].youtubeId}` : null,
      privacy: uploads[0]?.privacy || '',
      duplicates: Math.max(0, uploads.length - 1),
      // 제목의 max와 실제 파일 수가 다르면 다른 구성으로 올린 것일 수 있어 표시만 해둔다.
      maxMismatch: uploads[0] ? uploads[0].max !== files.length : false,
    };
  });
  return {
    videoId: String(videoId),
    fileCount: files.length,
    files: result,
    complete: result.every((f) => f.uploaded),
  };
}
