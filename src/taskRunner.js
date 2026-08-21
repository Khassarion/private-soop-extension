/**
 * 노래 길이 동안 작업을 실행하는 모듈
 */

class TaskRunner {
  constructor() {
    this.isRunning = false;
    this.startTime = null;
    this.duration = 0;
    this.intervalId = null;
    this.callbacks = {
      onStart: null,
      onTick: null,
      onComplete: null,
      onStop: null
    };
  }

  /**
   * 작업을 시작합니다
   * @param {number} durationInSeconds - 실행할 시간 (초)
   * @param {Function} taskFunction - 실행할 작업 함수 (선택사항)
   * @param {Object} options - 옵션 객체
   */
  async start(durationInSeconds, taskFunction = null, options = {}) {
    if (this.isRunning) {
      throw new Error('이미 실행 중인 작업이 있습니다.');
    }

    this.duration = durationInSeconds;
    this.isRunning = true;
    this.startTime = Date.now();
    const endTime = this.startTime + (durationInSeconds * 1000);

    // 시작 콜백 호출
    if (this.callbacks.onStart) {
      this.callbacks.onStart({
        duration: durationInSeconds,
        startTime: this.startTime
      });
    }

    // 작업 함수가 있으면 실행
    if (taskFunction && typeof taskFunction === 'function') {
      try {
        await taskFunction();
      } catch (error) {
        console.error('작업 실행 오류:', error);
      }
    }

    // 주기적으로 진행 상황 업데이트
    this.intervalId = setInterval(() => {
      const now = Date.now();
      const elapsed = Math.floor((now - this.startTime) / 1000);
      const remaining = Math.max(0, durationInSeconds - elapsed);
      const progress = Math.min(100, (elapsed / durationInSeconds) * 100);

      // 틱 콜백 호출
      if (this.callbacks.onTick) {
        this.callbacks.onTick({
          elapsed: elapsed,
          remaining: remaining,
          progress: progress,
          isComplete: remaining === 0
        });
      }

      // 시간이 다 되면 완료
      if (now >= endTime) {
        this.stop(true);
      }
    }, 100); // 100ms마다 업데이트
  }

  /**
   * 작업을 중지합니다
   * @param {boolean} isComplete - 완료로 인한 중지인지 여부
   */
  stop(isComplete = false) {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);

    if (isComplete && this.callbacks.onComplete) {
      this.callbacks.onComplete({
        elapsed: elapsed,
        duration: this.duration
      });
    } else if (!isComplete && this.callbacks.onStop) {
      this.callbacks.onStop({
        elapsed: elapsed,
        duration: this.duration
      });
    }

    this.startTime = null;
    this.duration = 0;
  }

  /**
   * 콜백 함수를 등록합니다
   * @param {string} event - 이벤트 이름 ('onStart', 'onTick', 'onComplete', 'onStop')
   * @param {Function} callback - 콜백 함수
   */
  on(event, callback) {
    if (this.callbacks.hasOwnProperty(event)) {
      this.callbacks[event] = callback;
    } else {
      console.warn(`알 수 없는 이벤트: ${event}`);
    }
  }

  /**
   * 현재 상태를 반환합니다
   * @returns {Object} 현재 상태 정보
   */
  getStatus() {
    if (!this.isRunning) {
      return {
        isRunning: false,
        elapsed: 0,
        remaining: 0,
        progress: 0
      };
    }

    const now = Date.now();
    const elapsed = Math.floor((now - this.startTime) / 1000);
    const remaining = Math.max(0, this.duration - elapsed);
    const progress = Math.min(100, (elapsed / this.duration) * 100);

    return {
      isRunning: true,
      elapsed: elapsed,
      remaining: remaining,
      progress: progress,
      duration: this.duration
    };
  }
}

// 모듈 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TaskRunner;
}
