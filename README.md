# 노래 길이 작업 실행기 Chrome 확장 프로그램

노래를 검색하여 길이를 가져오고, 그 길이 동안 특정 작업을 실행하는 Chrome 확장 프로그램입니다.

## 기능

1. **노래 검색**: YouTube Data API를 사용하여 노래를 검색하고 길이 정보를 가져옵니다.
2. **작업 실행**: 검색한 노래의 길이 동안 작업을 실행합니다.
3. **진행 상황 표시**: 실시간으로 작업 진행 상황을 표시합니다.

## 설치 방법

1. Chrome 브라우저에서 `chrome://extensions/` 접속
2. 우측 상단의 "개발자 모드" 활성화
3. "압축해제된 확장 프로그램을 로드합니다" 클릭
4. 이 프로젝트 폴더 선택

## YouTube API Key 설정

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트 생성
2. YouTube Data API v3 활성화
3. API Key 생성
4. 확장 프로그램의 팝업에서 API Key 입력 및 저장

## 사용 방법

1. 확장 프로그램 아이콘 클릭
2. YouTube API Key 입력 (처음 한 번만)
3. 노래 제목 또는 아티스트명 검색
4. 검색 결과 확인
5. 작업 설명 입력 (선택사항)
6. "작업 시작" 버튼 클릭
7. 노래 길이 동안 작업이 실행됩니다

## 파일 구조

- `manifest.json`: Chrome 확장 프로그램 설정 파일
- `popup.html`: 팝업 UI
- `popup.js`: 팝업 로직
- `songSearch.js`: 노래 검색 및 길이 가져오기 모듈
- `taskRunner.js`: 작업 실행 모듈
- `background.js`: 백그라운드 서비스 워커
- `styles.css`: 스타일시트

## 커스터마이징

`popup.js`의 `handleStartTask` 함수에서 `taskFunction`을 수정하여 원하는 작업을 구현할 수 있습니다.

예시:
- 탭 새로고침
- 특정 웹사이트 방문
- 알림 표시
- 기타 자동화 작업

## 라이선스

MIT
