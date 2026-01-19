/**
 * Background Service Worker
 * 확장 프로그램의 백그라운드 작업을 처리합니다.
 */

// 확장 프로그램 설치 시
chrome.runtime.onInstalled.addListener(() => {
  console.log('노래 길이 작업 실행기 확장 프로그램이 설치되었습니다.');
});

// 메시지 리스너
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStatus') {
    // 상태 정보 반환
    sendResponse({ status: 'active' });
  }
  return true;
});
