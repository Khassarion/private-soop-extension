# 노래 길이 작업 실행기 Chrome 확장 프로그램

Soop 생방송 페이지에 제어 패널을 삽입하고, 검색한 노래의 길이 동안 채팅 이모티콘을 자동 전송하는 Chrome 확장 프로그램입니다.

## 기능

1. **노래 검색**: YouTube Data API로 노래와 재생 시간을 검색합니다.
2. **응원봉 자동 전송**: 노래 길이 동안 지정한 Soop 채팅 이모티콘을 반복 전송합니다.
3. **페이지 패널**: 팝업을 닫아도 유지되는 시작·중지·진행 상태 UI를 제공합니다.

## 설치 방법

1. Chrome 브라우저에서 `chrome://extensions/` 접속
2. 우측 상단의 "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. 이 프로젝트 폴더 선택
5. `https://play.sooplive.com` 생방송 페이지를 새로고침

## 사용 방법

1. 페이지 오른쪽 위에 표시되는 제어 패널에 YouTube API Key 입력
2. 노래 제목 또는 아티스트명 검색
3. 이모티콘 문자열과 전송 개수·간격 설정
4. "작업 시작" 버튼 클릭
5. 노래 길이 동안 Soop 채팅창에 이모티콘이 자동 전송됩니다
6. 중지하려면 페이지 패널의 "중지" 버튼 클릭

자동 전송은 Soop 탭의 content script에서 실행됩니다. 채팅 입력창에 글자가 있거나 지정한 이모티콘 버튼을 찾을 수 없으면 입력 내용을 보호하기 위해 자동 전송을 중지합니다.

## 파일 구조

- `manifest.json`: Chrome 확장 프로그램 설정
- `src/content.js`: Soop 페이지 패널과 자동 전송 로직
- `src/songSearch.js`: YouTube 노래 검색 및 길이 조회 모듈
- `src/background.js`: 백그라운드 서비스 워커
- `src/popup.html`, `src/popup.js`: 이전 팝업 구현 파일 (현재 사용하지 않음)
- `src/styles.css`: 이전 팝업 스타일

## 응원봉 전송 설정

- 이모티콘 문자열: `/응원봉2/`처럼 슬래시로 감싼 Soop 이모티콘 문자열
- 한 번에 보낼 개수: 1~20개
- 전송 간격: 최소 1초 이상, 최소 간격부터 최대 간격까지 무작위
- 실행 시간: 검색한 YouTube 노래의 길이

## YouTube API Key

[Google Cloud Console](https://console.cloud.google.com/)에서 YouTube Data API v3를 활성화하고 API Key를 발급한 뒤 패널에 저장합니다.

## 라이선스

MIT
