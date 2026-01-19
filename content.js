/**
 * Content Script for Soop (play.sooplive.co.kr)
 * Soop 페이지에서 실행되는 스크립트
 */

// 확장 프로그램에서 메시지 수신
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getSoopInfo') {
    try {
      const info = extractSoopInfo();
      sendResponse({ success: true, data: info });
    } catch (error) {
      sendResponse({ success: false, error: error.message });
    }
    return true; // 비동기 응답을 위해 true 반환
  }
  
  // 다른 액션 처리
  if (request.action === 'customAction') {
    // 커스텀 작업 구현
    sendResponse({ success: true, message: 'Custom action executed' });
    return true;
  }
});

/**
 * Soop 페이지에서 정보 추출
 * @returns {Object} 추출된 정보
 */
function extractSoopInfo() {
  const info = {
    title: document.title || '',
    url: window.location.href,
    timestamp: Date.now(),
    // 여기에 Soop 페이지의 특정 요소를 추출하는 로직 추가
    // 예: 재생 중인 곡 정보, 재생 시간 등
  };

  // 페이지의 특정 요소 찾기 (예시)
  // 실제 Soop 페이지 구조에 맞게 수정 필요
  try {
    // 예시: 특정 클래스나 ID를 가진 요소 찾기
    // const playerElement = document.querySelector('.player');
    // if (playerElement) {
    //   info.playerInfo = playerElement.textContent;
    // }
  } catch (error) {
    console.error('Soop 정보 추출 오류:', error);
  }

  return info;
}

// 페이지 로드 완료 시 초기화
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSoop);
} else {
  initializeSoop();
}

function initializeSoop() {
  console.log('Soop Content Script 초기화됨');
  // 초기화 로직 추가
}
