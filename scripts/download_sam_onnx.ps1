# ============================================================
#  The Circle — SAM ONNX Model Downloader (Windows/PowerShell)
#
#  Downloads MobileSAM encoder + decoder ONNX files to:
#    client\public\models\   — CRA 개발서버가 정적 파일로 서빙
#
#  사용법:
#    .\scripts\download_sam_onnx.ps1
#    .\scripts\download_sam_onnx.ps1 -FrontendOnly
#    .\scripts\download_sam_onnx.ps1 -Force   # 이미 있어도 재다운로드
# ============================================================
param(
    [switch]$FrontendOnly,
    [switch]$Force
)

$ScriptDir   = $PSScriptRoot
$RepoRoot    = Split-Path $ScriptDir -Parent
$FrontendDir = Join-Path $RepoRoot "client\public\models"

$ENCODER_URL  = "https://huggingface.co/dhkim2810/MobileSAM/resolve/main/mobile_sam_encoder.onnx"
$DECODER_URL  = "https://huggingface.co/dhkim2810/MobileSAM/resolve/main/mobile_sam_decoder.onnx"
$ENCODER_FILE = Join-Path $FrontendDir "sam_encoder.onnx"
$DECODER_FILE = Join-Path $FrontendDir "sam_decoder.onnx"

function Write-Ok  { param($m) Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Info{ param($m) Write-Host "[INFO] $m" -ForegroundColor Cyan }
function Write-Warn{ param($m) Write-Host "[WARN] $m" -ForegroundColor Yellow }

function Download-Model {
    param([string]$Url, [string]$Dest, [string]$Label)

    if ((Test-Path $Dest) -and -not $Force) {
        $size = (Get-Item $Dest).Length / 1MB
        Write-Ok "SKIP  $Label (이미 존재: $([math]::Round($size,1)) MB)"
        return
    }

    Write-Info "DOWN  $Label"
    Write-Info "      $Url"
    Write-Info "      → $Dest"

    New-Item -ItemType Directory -Force -Path (Split-Path $Dest) | Out-Null

    try {
        # Invoke-WebRequest는 느릴 수 있어서 WebClient 사용
        $wc = New-Object System.Net.WebClient
        $wc.Headers.Add("User-Agent", "PowerShell/SAM-Downloader")
        $wc.DownloadFile($Url, $Dest)

        $size = (Get-Item $Dest).Length / 1MB
        Write-Ok "DONE  $Label ($([math]::Round($size,1)) MB)"
    } catch {
        Write-Warn "WebClient 실패, Invoke-WebRequest 재시도..."
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing
        $size = (Get-Item $Dest).Length / 1MB
        Write-Ok "DONE  $Label ($([math]::Round($size,1)) MB)"
    }
}

Write-Info "========================================"
Write-Info "  SAM ONNX 모델 다운로드"
Write-Info "  대상: $FrontendDir"
Write-Info "========================================"

Download-Model -Url $ENCODER_URL -Dest $ENCODER_FILE -Label "MobileSAM Encoder (~40 MB)"
Download-Model -Url $DECODER_URL -Dest $DECODER_FILE -Label "SAM Decoder (~3.6 MB)"

Write-Info ""
Write-Ok "완료! 이제 dev.ps1 start 로 서버를 시작하세요."
Write-Info "브라우저에서 처음 세그멘테이션 페이지 진입 시 모델을 로드합니다."
