# =============================================================================
#  dev.ps1 — The Circle 로컬 개발 서버 통합 실행 스크립트 (Windows)
#
#  사용법 (PowerShell):
#    .\dev.ps1           # 전체 시작 (DB + 백엔드 + 프론트엔드)
#    .\dev.ps1 start     # 위와 동일
#    .\dev.ps1 stop      # 전체 종료
#    .\dev.ps1 restart   # 전체 재시작
#    .\dev.ps1 status    # 실행 상태 확인
#    .\dev.ps1 logs      # 실시간 로그 (백엔드 + 프론트엔드)
#    .\dev.ps1 logs be   # 백엔드 로그만
#    .\dev.ps1 logs fe   # 프론트엔드 로그만
#    .\dev.ps1 db        # DB(Docker)만 시작
#    .\dev.ps1 be        # 백엔드만 시작
#    .\dev.ps1 fe        # 프론트엔드만 시작
#
#  실행 정책 오류 시:
#    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# =============================================================================
param(
    [Parameter(Position=0)] [string]$Command = "start",
    [Parameter(Position=1)] [string]$SubCommand = ""
)

$ErrorActionPreference = "Continue"

# ── 경로 설정 ──────────────────────────────────────────────────────────────────
$ScriptDir   = $PSScriptRoot
$BackendDir  = Join-Path $ScriptDir "backend"
$FrontendDir = Join-Path $ScriptDir "client"
$ComposeFile = Join-Path $ScriptDir "docker-compose.dev.yml"

$LogDir  = Join-Path $ScriptDir ".dev_logs"
$PidFile = Join-Path $ScriptDir ".dev_pids"
$BeLog   = Join-Path $LogDir "backend.log"
$FeLog   = Join-Path $LogDir "frontend.log"

$BePort = 8000
$FePort = 3000
$DbPort = 5432

# ── 색상 헬퍼 ─────────────────────────────────────────────────────────────────
function Write-Info  { param($msg) Write-Host "[INFO] $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Err   { param($msg) Write-Host "[ERR ] $msg" -ForegroundColor Red }
function Write-Header {
    param($msg)
    Write-Host ""
    Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host "  The Circle — 개발 서버  $msg" -ForegroundColor Cyan
    Write-Host "══════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
}

# ── PID 파일 관리 ──────────────────────────────────────────────────────────────
function Get-SavedPid {
    param([string]$Key)
    if (-not (Test-Path $PidFile)) { return $null }
    $line = Get-Content $PidFile | Where-Object { $_ -match "^${Key}=" } | Select-Object -First 1
    if ($line) { return [int]($line -split "=",2)[1] }
    return $null
}

function Save-Pid {
    param([string]$Key, [int]$Pid)
    $lines = @()
    if (Test-Path $PidFile) {
        $lines = Get-Content $PidFile | Where-Object { $_ -notmatch "^${Key}=" }
    }
    $lines += "${Key}=${Pid}"
    $lines | Set-Content $PidFile -Encoding UTF8
}

function Remove-SavedPid {
    param([string]$Key)
    if (-not (Test-Path $PidFile)) { return }
    $lines = Get-Content $PidFile | Where-Object { $_ -notmatch "^${Key}=" }
    if ($lines) { $lines | Set-Content $PidFile -Encoding UTF8 }
    else { Remove-Item $PidFile -Force -ErrorAction SilentlyContinue }
}

# ── 프로세스/포트 유틸 ────────────────────────────────────────────────────────
function Test-ProcessAlive {
    param([int]$Pid)
    if (-not $Pid) { return $false }
    return $null -ne (Get-Process -Id $Pid -ErrorAction SilentlyContinue)
}

function Test-PortInUse {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

function Get-PidOnPort {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Stop-ProcessTree {
    param([int]$Pid)
    if (-not $Pid) { return }
    # 자식 프로세스까지 모두 종료
    $children = Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $Pid }
    foreach ($child in $children) { Stop-ProcessTree -Pid $child.ProcessId }
    Stop-Process -Id $Pid -Force -ErrorAction SilentlyContinue
}

function Ensure-LogDir {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
}

# ── venv / Python 탐지 ────────────────────────────────────────────────────────
function Find-Python {
    $candidates = @(
        (Join-Path $BackendDir ".venv\Scripts\python.exe"),
        (Join-Path $BackendDir "venv\Scripts\python.exe"),
        (Join-Path $ScriptDir  ".venv\Scripts\python.exe")
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    # PATH에서 python 찾기
    $p = Get-Command python -ErrorAction SilentlyContinue
    if ($p) { return $p.Source }
    $p = Get-Command python3 -ErrorAction SilentlyContinue
    if ($p) { return $p.Source }
    return $null
}

# ── .env 로드 (백엔드) ─────────────────────────────────────────────────────────
function Import-DotEnv {
    param([string]$EnvFile)
    if (-not (Test-Path $EnvFile)) { return }
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -match "^#" -or $line -eq "") { return }
        if ($line -match "^([^=]+)=(.*)$") {
            $k = $Matches[1].Trim()
            $v = $Matches[2].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($k, $v, "Process")
        }
    }
}

# ── Docker 데몬 실행 확인 ─────────────────────────────────────────────────────
function Test-DockerRunning {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
    $info = docker info 2>&1
    return $LASTEXITCODE -eq 0
}

# ── DB 시작 ───────────────────────────────────────────────────────────────────
function Start-Db {
    Write-Info "DB(PostgreSQL) 시작 중..."

    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Warn "Docker가 설치되지 않았습니다 — DB 건너뜀"
        return
    }
    if (-not (Test-Path $ComposeFile)) {
        Write-Warn "docker-compose.dev.yml 없음 — DB 건너뜀"
        return
    }
    if (-not (Test-DockerRunning)) {
        Write-Warn "Docker 데몬이 실행되지 않았습니다."
        Write-Warn "Docker Desktop을 시작한 후 다시 실행하세요."
        Write-Warn "DB 없이 계속 진행합니다 (백엔드가 DB에 연결되지 않을 수 있음)"
        return
    }

    $output = docker compose -f $ComposeFile up -d --quiet-pull 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn "docker compose 실패 (종료코드: $LASTEXITCODE)"
        $output | ForEach-Object { Write-Host "  [docker] $_" -ForegroundColor DarkGray }
        return
    }
    $output | ForEach-Object { Write-Host "  [docker] $_" -ForegroundColor DarkGray }

    # 헬스체크 (최대 20초)
    $ok = $false
    for ($i = 0; $i -lt 20; $i++) {
        $null = docker compose -f $ComposeFile exec -T db pg_isready -U circle_user -d the_circle 2>&1
        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        Start-Sleep -Seconds 1
        Write-Host "." -NoNewline
    }
    if ($i -gt 0) { Write-Host "" }
    if (-not $ok) { Write-Warn "DB 헬스체크 타임아웃 (계속 진행)" }
    else { Write-Ok "DB 준비 완료 (localhost:${DbPort})" }
}

# ── 백엔드 시작 ───────────────────────────────────────────────────────────────
function Start-Backend {
    $pid = Get-SavedPid "BE"
    if (Test-ProcessAlive $pid) {
        Write-Warn "백엔드 이미 실행 중 (PID $pid)"
        return
    }

    if (-not (Test-Path $BackendDir)) {
        Write-Err "backend/ 디렉토리를 찾을 수 없습니다"; exit 1
    }

    $python = Find-Python
    if (-not $python) {
        Write-Err "Python을 찾을 수 없습니다. Python 3.9+ 설치 후 재시도하세요."; exit 1
    }

    # .env 없으면 .env.example에서 복사
    $envFile = Join-Path $BackendDir ".env"
    $envExample = Join-Path $BackendDir ".env.example"
    if (-not (Test-Path $envFile) -and (Test-Path $envExample)) {
        Copy-Item $envExample $envFile
        Write-Info "backend/.env 생성됨 (from .env.example)"
    }
    Import-DotEnv $envFile

    Ensure-LogDir
    Write-Info "백엔드 시작 중 (포트 $BePort)..."

    $proc = Start-Process -FilePath $python `
        -ArgumentList "-m", "uvicorn", "app.main:app", "--reload", "--host", "0.0.0.0", "--port", "$BePort" `
        -WorkingDirectory $BackendDir `
        -RedirectStandardOutput $BeLog `
        -RedirectStandardError "$LogDir\backend_err.log" `
        -WindowStyle Hidden `
        -PassThru

    Save-Pid "BE" $proc.Id

    # 기동 확인 (최대 10초)
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-PortInUse $BePort) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-PortInUse $BePort)) {
        Write-Warn "백엔드 기동 확인 타임아웃 (로그 확인: $BeLog)"
    } else {
        Write-Ok "백엔드 실행 중 (PID $($proc.Id)) → http://localhost:$BePort"
        Write-Ok "  API 문서: http://localhost:${BePort}/docs"
    }
}

# ── 프론트엔드 시작 ───────────────────────────────────────────────────────────
function Start-Frontend {
    $pid = Get-SavedPid "FE"
    if (Test-ProcessAlive $pid) {
        Write-Warn "프론트엔드 이미 실행 중 (PID $pid)"
        return
    }

    if (-not (Test-Path $FrontendDir)) {
        Write-Err "client/ 디렉토리를 찾을 수 없습니다"; exit 1
    }

    # node_modules 확인
    $nodeModules = Join-Path $FrontendDir "node_modules"
    if (-not (Test-Path $nodeModules)) {
        Write-Info "node_modules 없음 — npm install 실행 중..."
        Push-Location $FrontendDir
        npm install --silent
        Pop-Location
    }

    # .env 없으면 .env.example에서 복사 (BROWSER=none 포함)
    $feEnv = Join-Path $FrontendDir ".env"
    $feEnvExample = Join-Path $FrontendDir ".env.example"
    if (-not (Test-Path $feEnv) -and (Test-Path $feEnvExample)) {
        Copy-Item $feEnvExample $feEnv
        Write-Info "client/.env 생성됨 (from .env.example)"
    }

    Ensure-LogDir
    Write-Info "프론트엔드 시작 중 (포트 $FePort)..."

    # npm start — BROWSER=none으로 자동 브라우저 열기 방지
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npmCmd) { Write-Err "npm을 찾을 수 없습니다. Node.js 설치 후 재시도하세요."; exit 1 }
    $npmPath = $npmCmd.Source

    $env:BROWSER = "none"
    $proc = Start-Process -FilePath $npmPath `
        -ArgumentList "start" `
        -WorkingDirectory $FrontendDir `
        -RedirectStandardOutput $FeLog `
        -RedirectStandardError "$LogDir\frontend_err.log" `
        -WindowStyle Hidden `
        -PassThru

    Save-Pid "FE" $proc.Id

    # 기동 확인 (최대 60초 — CRA는 느림)
    Write-Host "  CRA 빌드 중" -NoNewline
    for ($i = 0; $i -lt 60; $i++) {
        if (Test-PortInUse $FePort) { break }
        Start-Sleep -Seconds 1
        if ($i % 5 -eq 4) { Write-Host "." -NoNewline }
    }
    Write-Host ""

    if (-not (Test-PortInUse $FePort)) {
        Write-Warn "프론트엔드 기동 확인 타임아웃 (로그 확인: $FeLog)"
    } else {
        Write-Ok "프론트엔드 실행 중 (PID $($proc.Id)) → http://localhost:$FePort"
    }
}

# ── 백엔드 종료 ───────────────────────────────────────────────────────────────
function Stop-Backend {
    $pid = Get-SavedPid "BE"
    if (Test-ProcessAlive $pid) {
        Write-Info "백엔드 종료 중 (PID $pid)..."
        Stop-ProcessTree -Pid $pid
        Write-Ok "백엔드 종료됨"
    } else {
        Write-Info "백엔드 실행 중이 아닙니다"
    }
    # 포트에 남아있는 프로세스 정리
    $lingering = Get-PidOnPort $BePort
    if ($lingering) { Stop-Process -Id $lingering -Force -ErrorAction SilentlyContinue }
    Remove-SavedPid "BE"
}

# ── 프론트엔드 종료 ───────────────────────────────────────────────────────────
function Stop-Frontend {
    $pid = Get-SavedPid "FE"
    if (Test-ProcessAlive $pid) {
        Write-Info "프론트엔드 종료 중 (PID $pid)..."
        Stop-ProcessTree -Pid $pid
        Write-Ok "프론트엔드 종료됨"
    } else {
        Write-Info "프론트엔드 실행 중이 아닙니다"
    }
    $lingering = Get-PidOnPort $FePort
    if ($lingering) { Stop-Process -Id $lingering -Force -ErrorAction SilentlyContinue }
    Remove-SavedPid "FE"
}

# ── DB 종료 ───────────────────────────────────────────────────────────────────
function Stop-Db {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return }
    if (-not (Test-Path $ComposeFile)) { return }
    if (-not (Test-DockerRunning)) {
        Write-Warn "Docker 데몬이 실행되지 않아 DB 종료를 건너뜁니다"
        return
    }
    Write-Info "DB 종료 중..."
    $output = docker compose -f $ComposeFile down 2>&1
    $output | ForEach-Object { Write-Host "  [docker] $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -eq 0) { Write-Ok "DB 종료됨" }
    else { Write-Warn "docker compose down 실패 (종료코드: $LASTEXITCODE)" }
}

# ── 상태 확인 ─────────────────────────────────────────────────────────────────
function Show-Status {
    Write-Host ""
    Write-Host "  서비스 상태" -ForegroundColor White
    Write-Host "  ─────────────────────────────────"

    # DB
    $dbStatus = "정지"
    $dbColor  = "Red"
    if ((Get-Command docker -ErrorAction SilentlyContinue) -and (Test-Path $ComposeFile)) {
        $r = docker compose -f $ComposeFile exec -T db pg_isready -U circle_user 2>&1
        if ($LASTEXITCODE -eq 0) { $dbStatus = "실행 중 (localhost:${DbPort})"; $dbColor = "Green" }
    }
    Write-Host ("  {0,-16}" -f "DB (Postgres)") -NoNewline; Write-Host $dbStatus -ForegroundColor $dbColor

    # 백엔드
    $bePid = Get-SavedPid "BE"
    if (Test-ProcessAlive $bePid) {
        $beStatus = "실행 중 (PID $bePid, localhost:$BePort)"; $beColor = "Green"
    } elseif (Test-PortInUse $BePort) {
        $beStatus = "포트 사용 중 (PID 불명, localhost:$BePort)"; $beColor = "Yellow"
    } else {
        $beStatus = "정지"; $beColor = "Red"
    }
    Write-Host ("  {0,-16}" -f "백엔드") -NoNewline; Write-Host $beStatus -ForegroundColor $beColor

    # 프론트엔드
    $fePid = Get-SavedPid "FE"
    if (Test-ProcessAlive $fePid) {
        $feStatus = "실행 중 (PID $fePid, localhost:$FePort)"; $feColor = "Green"
    } elseif (Test-PortInUse $FePort) {
        $feStatus = "포트 사용 중 (PID 불명, localhost:$FePort)"; $feColor = "Yellow"
    } else {
        $feStatus = "정지"; $feColor = "Red"
    }
    Write-Host ("  {0,-16}" -f "프론트엔드") -NoNewline; Write-Host $feStatus -ForegroundColor $feColor

    Write-Host "  ─────────────────────────────────"
    Write-Host "  로그 위치: $LogDir" -ForegroundColor DarkGray
    Write-Host ""
}

# ── 로그 보기 ─────────────────────────────────────────────────────────────────
function Show-Logs {
    param([string]$Target = "both")
    Ensure-LogDir
    if (-not (Test-Path $BeLog)) { "" | Set-Content $BeLog }
    if (-not (Test-Path $FeLog)) { "" | Set-Content $FeLog }

    switch ($Target) {
        { $_ -in "be","backend" } {
            Write-Info "백엔드 로그 (Ctrl+C로 종료)"
            Get-Content $BeLog -Wait
        }
        { $_ -in "fe","frontend" } {
            Write-Info "프론트엔드 로그 (Ctrl+C로 종료)"
            Get-Content $FeLog -Wait
        }
        default {
            Write-Info "백엔드 + 프론트엔드 로그 (Ctrl+C로 종료)"
            # 두 파일을 동시에 tail -f
            $job1 = Start-Job { Get-Content $using:BeLog -Wait | ForEach-Object { "[BE] $_" } }
            $job2 = Start-Job { Get-Content $using:FeLog -Wait | ForEach-Object { "[FE] $_" } }
            try {
                while ($true) {
                    Receive-Job $job1, $job2
                    Start-Sleep -Milliseconds 200
                }
            } finally {
                Stop-Job $job1, $job2 -ErrorAction SilentlyContinue
                Remove-Job $job1, $job2 -ErrorAction SilentlyContinue
            }
        }
    }
}

# ── 도움말 ────────────────────────────────────────────────────────────────────
function Show-Help {
    Write-Host ""
    Write-Host "사용법: .\dev.ps1 [커맨드]" -ForegroundColor White
    Write-Host ""
    Write-Host "커맨드:" -ForegroundColor White
    Write-Host "  start       DB + 백엔드 + 프론트엔드 모두 시작 (기본)" -ForegroundColor Green
    Write-Host "  stop        모두 종료" -ForegroundColor Red
    Write-Host "  restart     재시작" -ForegroundColor Yellow
    Write-Host "  status      실행 상태 확인" -ForegroundColor Cyan
    Write-Host "  logs        실시간 전체 로그" -ForegroundColor Cyan
    Write-Host "  logs be     백엔드 로그만" -ForegroundColor Cyan
    Write-Host "  logs fe     프론트엔드 로그만" -ForegroundColor Cyan
    Write-Host "  db          DB(Docker)만 시작" -ForegroundColor Blue
    Write-Host "  be          백엔드만 시작" -ForegroundColor Blue
    Write-Host "  fe          프론트엔드만 시작" -ForegroundColor Blue
    Write-Host ""
    Write-Host "로그 파일:" -ForegroundColor White
    Write-Host "  백엔드     $BeLog"
    Write-Host "  프론트엔드 $FeLog"
    Write-Host ""
    Write-Host "실행 정책 오류 시:" -ForegroundColor Yellow
    Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser"
    Write-Host ""
}

# ── 메인 ──────────────────────────────────────────────────────────────────────
switch ($Command.ToLower()) {
    "start" {
        Write-Header "시작"
        Start-Db
        Write-Host ""
        Start-Backend
        Write-Host ""
        Start-Frontend
        Write-Host ""
        Show-Status
        Write-Host "  모두 준비됐습니다!" -ForegroundColor Green
        Write-Host "  프론트엔드  → " -NoNewline; Write-Host "http://localhost:$FePort" -ForegroundColor Cyan
        Write-Host "  백엔드 API  → " -NoNewline; Write-Host "http://localhost:${BePort}/docs" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  종료하려면: .\dev.ps1 stop" -ForegroundColor DarkGray
        Write-Host ""
    }
    "stop" {
        Write-Header "종료"
        Stop-Frontend
        Write-Host ""
        Stop-Backend
        Write-Host ""
        Stop-Db
        Write-Host ""
        Write-Ok "모든 서비스가 종료됐습니다"
        Write-Host ""
    }
    "restart" {
        & $PSCommandPath stop
        Start-Sleep -Seconds 1
        & $PSCommandPath start
    }
    "status"  { Show-Status }
    "logs"    { Show-Logs $SubCommand }
    "db"      { Start-Db }
    "be"      { Start-Backend }
    "fe"      { Start-Frontend }
    { $_ -in "help","-h","--help" } { Show-Help }
    default {
        Write-Err "알 수 없는 커맨드: $Command"
        Show-Help
        exit 1
    }
}
