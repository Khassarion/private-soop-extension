# 크롬이 꺼져있으면(예: 비정상 종료) 다시 켜준다. 확장 프로그램 기능이 아니라 작업 스케줄러가
# 주기적으로 실행하는 별도의 로컬 스크립트다 — 확장은 크롬 자체가 꺼지면 같이 꺼져버려서
# 감지/복구를 할 수 있는 주체가 없기 때문에, 이 역할은 확장 밖(OS 수준)에서 해야 한다.
#
# 반드시 "나만의 SOOP 확프"가 활성화된 프로필로 켜야 한다 — Default 프로필엔 이 확장이
# disable_reasons로 꺼져 있고, 실제로 쓰는 건 Profile 8(noirassahk@gmail.com, "카사리온")이다.
# 두 프로필의 Secure Preferences에서 직접 확인함(2026-10-17). 프로필 디렉터리 이름 자체가
# 바뀌면(계정을 새로 추가/정리하는 등) 이 값도 같이 바꿔야 한다.
$TargetProfileDirectory = 'Profile 8'

# 주의: 이 스크립트는 "크롬 프로세스가 켜져 있게" 만들 뿐이다. 꺼지기 전에 열려 있던 탭/작업
# (유튜브 업로드 배치, 재생목록 자동 추가 등)은 자동으로 이어지지 않는다 — 크롬의
# "마지막으로 종료할 때 열려 있던 페이지들" 설정(chrome://settings/onStartup)이 켜져 있어야
# 탭들이 다시 열리고, 그래도 배치 자체는 수동으로 다시 시작해야 한다(이 저장소 CLAUDE.md에
# "복원력은 의도적으로 없다"고 적어둔 부분과 같은 이유).

$ChromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
)
$ChromeExe = $ChromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
$LogPath = Join-Path $PSScriptRoot 'watch-chrome.log'

function Write-Log($message) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  # PowerShell 5.1의 Add-Content 기본 인코딩은 UTF-8이 아니라 시스템 ANSI 코드페이지라
  # 한글이 깨진다 — 명시적으로 utf8을 줘야 한다.
  Add-Content -Path $LogPath -Value "$timestamp $message" -Encoding utf8
}

if (-not $ChromeExe) {
  Write-Log '크롬 실행 파일을 찾지 못함 - 설치 경로 확인 필요'
  exit 1
}

# "진짜 메인 브라우저 창" 프로세스가 있는지로 판단한다 — 단순히 Get-Process -Name chrome로
# chrome.exe가 존재하는지만 보면 안 된다: 메인 브라우저가 죽어도 그 자식 프로세스(렌더러/GPU/
# crashpad-handler 등, 커맨드라인에 --type=... 이 붙음)가 좀비로 잠깐~계속 남아있을 수 있고,
# 이 PC에서는 Claude Code의 자체 자동화용 헤드리스 크롬(--headless, 사용자 실제 브라우저와
# 무관)도 "chrome.exe"로 같이 잡힌다. 실제로 이 둘 때문에 "크롬이 켜져있다"고 오판해서
# 재실행을 건너뛴 적이 있었다(2026-10-17). 그래서 --type=이 없고 --headless도 아닌 프로세스가
# 하나라도 있어야 "진짜 메인 브라우저가 떠있다"고 본다.
$chromeProcs = Get-CimInstance Win32_Process -Filter "name='chrome.exe'" -ErrorAction SilentlyContinue
$mainBrowserRunning = $false
foreach ($p in $chromeProcs) {
  if ($p.CommandLine -notmatch '--type=' -and $p.CommandLine -notmatch '--headless') {
    $mainBrowserRunning = $true
    break
  }
}

if (-not $mainBrowserRunning) {
  Write-Log "크롬이 완전히 꺼져있음 - 다시 실행 (--profile-directory=`"$TargetProfileDirectory`")"
  Start-Process -FilePath $ChromeExe -ArgumentList "--profile-directory=`"$TargetProfileDirectory`""
}
