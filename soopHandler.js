/**
 * Soop (play.sooplive.co.kr) 핸들러 모듈
 * Soop 사이트에서 동작하는 기능을 처리합니다.
 */

class SoopHandler {
  constructor() {
    this.soopDomain = 'play.sooplive.co.kr';
    this.isActive = false;
  }

  /**
   * 현재 탭이 Soop 사이트인지 확인
   * @returns {Promise<boolean>} Soop 사이트 여부
   */
  async isSoopTab() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        return false;
      }
      
      const url = new URL(tab.url);
      return url.hostname === this.soopDomain || url.hostname.includes('sooplive.co.kr');
    } catch (error) {
      console.error('Soop 탭 확인 오류:', error);
      return false;
    }
  }

  /**
   * Soop 페이지에서 정보를 가져옵니다
   * @returns {Promise<Object>} Soop 페이지 정보
   */
  async getSoopInfo() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        throw new Error('활성 탭을 찾을 수 없습니다.');
      }

      // Content script에 메시지 전송하여 정보 가져오기
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'getSoopInfo' });
      
      if (!response) {
        throw new Error('Content script로부터 응답을 받을 수 없습니다. Soop 페이지를 새로고침해주세요.');
      }

      if (!response.success) {
        throw new Error(response.error || '정보를 가져오는 중 오류가 발생했습니다.');
      }

      return response.data;
    } catch (error) {
      // 메시지 전송 실패 시 (content script가 로드되지 않았을 수 있음)
      if (error.message && error.message.includes('Could not establish connection')) {
        throw new Error('Soop 페이지를 새로고침한 후 다시 시도해주세요.');
      }
      console.error('Soop 정보 가져오기 오류:', error);
      throw error;
    }
  }

  /**
   * Soop 페이지에 메시지를 보냅니다
   * @param {Object} message - 보낼 메시지
   * @returns {Promise<any>} 응답
   */
  async sendMessageToSoop(message) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        throw new Error('활성 탭을 찾을 수 없습니다.');
      }

      const response = await chrome.tabs.sendMessage(tab.id, message);
      return response;
    } catch (error) {
      console.error('Soop에 메시지 전송 오류:', error);
      throw error;
    }
  }

  /**
   * Soop 페이지에서 특정 작업을 실행합니다
   * @param {string} action - 실행할 작업
   * @param {Object} params - 작업 파라미터
   * @returns {Promise<any>} 실행 결과
   */
  async executeAction(action, params = {}) {
    try {
      const isSoop = await this.isSoopTab();
      if (!isSoop) {
        throw new Error('Soop 페이지가 아닙니다.');
      }

      // 작업별 로직 구현
      switch (action) {
        case 'getCurrentInfo':
          return await this.getSoopInfo();
        
        case 'customAction':
          // 커스텀 작업 구현
          return await this.sendMessageToSoop({ action, ...params });
        
        default:
          throw new Error(`알 수 없는 작업: ${action}`);
      }
    } catch (error) {
      console.error('Soop 작업 실행 오류:', error);
      throw error;
    }
  }
}

// 모듈 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SoopHandler;
}
