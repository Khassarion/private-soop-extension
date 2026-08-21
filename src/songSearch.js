/**
 * 노래 검색 및 길이 가져오는 모듈
 * YouTube Data API v3를 사용하여 노래를 검색하고 길이를 가져옵니다.
 */

class SongSearch {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://www.googleapis.com/youtube/v3';
  }

  /**
   * 노래를 검색하고 정보를 가져옵니다
   * @param {string} query - 검색할 노래 제목 또는 아티스트명
   * @returns {Promise<Object>} 노래 정보 (제목, 아티스트, 길이 등)
   */
  async searchSong(query) {
    try {
      // 1단계: 검색 API로 비디오 ID 찾기
      const searchUrl = `${this.baseUrl}/search?part=snippet&q=${encodeURIComponent(query)}&type=video&videoCategoryId=10&maxResults=1&key=${this.apiKey}`;
      
      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) {
        const errorData = await searchResponse.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || searchResponse.statusText;
        throw new Error(`검색 실패: ${errorMessage}`);
      }
      
      const searchData = await searchResponse.json();
      
      // API 에러 응답 확인
      if (searchData.error) {
        throw new Error(`검색 오류: ${searchData.error.message || '알 수 없는 오류가 발생했습니다.'}`);
      }
      
      if (!searchData.items || searchData.items.length === 0) {
        throw new Error('검색 결과가 없습니다. 다른 검색어를 시도해보세요.');
      }

      const videoId = searchData.items[0].id.videoId;
      const videoInfo = searchData.items[0].snippet;

      // 2단계: 비디오 상세 정보로 길이 가져오기
      const detailsUrl = `${this.baseUrl}/videos?part=contentDetails&id=${videoId}&key=${this.apiKey}`;
      
      const detailsResponse = await fetch(detailsUrl);
      if (!detailsResponse.ok) {
        const errorData = await detailsResponse.json().catch(() => ({}));
        const errorMessage = errorData.error?.message || detailsResponse.statusText;
        throw new Error(`상세 정보 가져오기 실패: ${errorMessage}`);
      }
      
      const detailsData = await detailsResponse.json();
      
      // API 에러 응답 확인
      if (detailsData.error) {
        throw new Error(`상세 정보 오류: ${detailsData.error.message || '알 수 없는 오류가 발생했습니다.'}`);
      }
      
      if (!detailsData.items || detailsData.items.length === 0) {
        throw new Error('비디오 상세 정보를 가져올 수 없습니다.');
      }

      const duration = detailsData.items[0].contentDetails.duration;
      const durationInSeconds = this.parseDuration(duration);

      return {
        videoId: videoId,
        title: videoInfo.title,
        channelTitle: videoInfo.channelTitle,
        thumbnail: videoInfo.thumbnails.default.url,
        duration: duration,
        durationInSeconds: durationInSeconds,
        url: `https://www.youtube.com/watch?v=${videoId}`
      };
    } catch (error) {
      // 에러를 그대로 throw하여 popup.js에서 처리하도록 함
      throw error;
    }
  }

  /**
   * ISO 8601 duration 형식 (PT4M13S)을 초 단위로 변환
   * @param {string} duration - ISO 8601 duration 문자열
   * @returns {number} 초 단위 길이
   */
  parseDuration(duration) {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    
    if (!match) {
      return 0;
    }

    const hours = parseInt(match[1] || 0, 10);
    const minutes = parseInt(match[2] || 0, 10);
    const seconds = parseInt(match[3] || 0, 10);

    return hours * 3600 + minutes * 60 + seconds;
  }

  /**
   * 초를 시:분:초 형식으로 변환
   * @param {number} seconds - 초 단위 시간
   * @returns {string} "MM:SS" 또는 "H:MM:SS" 형식
   */
  formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }
}

// 모듈 내보내기 (CommonJS 또는 ES6 모듈)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SongSearch;
}
