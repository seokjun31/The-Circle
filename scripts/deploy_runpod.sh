#!/usr/bin/env bash
# =============================================================================
#  The Circle — RunPod Serverless 배포 스크립트
#
#  사전 준비:
#    1. Docker 설치 및 로그인: docker login
#    2. 환경변수 설정:
#         export DOCKERHUB_USERNAME=your-username
#         export RUNPOD_API_KEY=your-api-key
#         export RUNPOD_ENDPOINT_ID=your-endpoint-id  (기존 엔드포인트 업데이트 시)
#
#  사용법:
#    # 신규 배포 (이미지 빌드 + 푸시만)
#    bash scripts/deploy_runpod.sh
#
#    # 기존 엔드포인트 업데이트
#    bash scripts/deploy_runpod.sh --update-endpoint
#
#    # 빌드 없이 RunPod 엔드포인트만 생성
#    bash scripts/deploy_runpod.sh --endpoint-only
# =============================================================================

set -euo pipefail

# ── 색상 출력 ────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}[INFO]${NC} $*"; }
log_success() { echo -e "${GREEN}[OK]${NC}   $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error()   { echo -e "${RED}[ERR]${NC}  $*"; }

# ── 설정 ─────────────────────────────────────────────────────────────────────
DOCKERHUB_USERNAME="${DOCKERHUB_USERNAME:-YOUR_DOCKERHUB_USERNAME}"
IMAGE_NAME="the-circle-comfyui"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="${DOCKERHUB_USERNAME}/${IMAGE_NAME}:${IMAGE_TAG}"

DOCKERFILE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker/comfyui"

# RunPod MVP 설정 (비용 최소화)
RUNPOD_GPU_IDS="NVIDIA GeForce RTX 4090,NVIDIA A40"
RUNPOD_MIN_WORKERS="${RUNPOD_MIN_WORKERS:-0}"     # Scale to Zero
RUNPOD_MAX_WORKERS="${RUNPOD_MAX_WORKERS:-3}"
RUNPOD_IDLE_TIMEOUT="${RUNPOD_IDLE_TIMEOUT:-30}"   # 30초 후 종료 (비용 절감)
RUNPOD_EXEC_TIMEOUT="${RUNPOD_EXEC_TIMEOUT:-300}"  # 최대 5분
RUNPOD_API_URL="https://api.runpod.io/graphql"

# ── 옵션 파싱 ─────────────────────────────────────────────────────────────────
BUILD=true
UPDATE_ENDPOINT=false
ENDPOINT_ONLY=false

for arg in "$@"; do
  case $arg in
    --update-endpoint) UPDATE_ENDPOINT=true ;;
    --endpoint-only)   ENDPOINT_ONLY=true; BUILD=false ;;
    --no-build)        BUILD=false ;;
    --help|-h)
      echo "사용법: bash scripts/deploy_runpod.sh [옵션]"
      echo "  --update-endpoint   기존 RunPod 엔드포인트 설정 업데이트"
      echo "  --endpoint-only     빌드 없이 RunPod 엔드포인트만 생성/업데이트"
      echo "  --no-build          Docker 빌드/푸시 건너뜀"
      exit 0
      ;;
  esac
done

# ── 사전 검증 ─────────────────────────────────────────────────────────────────
check_requirements() {
  log_info "사전 요구사항 확인 중..."

  if [[ "$DOCKERHUB_USERNAME" == "YOUR_DOCKERHUB_USERNAME" ]]; then
    log_error "DOCKERHUB_USERNAME 환경변수를 설정해주세요."
    echo "  export DOCKERHUB_USERNAME=your-username"
    exit 1
  fi

  if ! command -v docker &>/dev/null; then
    log_error "Docker가 설치되어 있지 않습니다."
    exit 1
  fi

  if [[ -n "${RUNPOD_API_KEY:-}" ]] && ! command -v curl &>/dev/null; then
    log_error "curl이 설치되어 있지 않습니다."
    exit 1
  fi

  log_success "사전 요구사항 확인 완료"
}

# ── Docker 이미지 빌드 + 푸시 ─────────────────────────────────────────────────
build_and_push() {
  log_info "Docker 이미지 빌드 시작: ${FULL_IMAGE}"
  log_info "Dockerfile 위치: ${DOCKERFILE_DIR}"

  docker build \
    --platform linux/amd64 \
    --tag "${FULL_IMAGE}" \
    --file "${DOCKERFILE_DIR}/Dockerfile" \
    "${DOCKERFILE_DIR}"

  log_success "빌드 완료: ${FULL_IMAGE}"

  log_info "DockerHub 푸시 중..."
  docker push "${FULL_IMAGE}"
  log_success "푸시 완료: ${FULL_IMAGE}"

  # latest 외에 git 커밋 해시로도 태그
  if command -v git &>/dev/null; then
    GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
    SHA_IMAGE="${DOCKERHUB_USERNAME}/${IMAGE_NAME}:${GIT_SHA}"
    docker tag "${FULL_IMAGE}" "${SHA_IMAGE}"
    docker push "${SHA_IMAGE}"
    log_success "SHA 태그 푸시 완료: ${SHA_IMAGE}"
  fi
}

# ── RunPod 엔드포인트 생성 ────────────────────────────────────────────────────
create_runpod_endpoint() {
  if [[ -z "${RUNPOD_API_KEY:-}" ]]; then
    log_warn "RUNPOD_API_KEY가 없습니다. RunPod 엔드포인트 생성을 건너뜁니다."
    log_warn "나중에 RunPod 대시보드(https://www.runpod.io/console/serverless)에서 수동으로 생성하세요."
    echo ""
    echo "  이미지: ${FULL_IMAGE}"
    echo "  GPU: RTX 4090 또는 A40"
    echo "  Min Workers: ${RUNPOD_MIN_WORKERS}"
    echo "  Max Workers: ${RUNPOD_MAX_WORKERS}"
    echo "  Idle Timeout: ${RUNPOD_IDLE_TIMEOUT}s"
    echo "  Execution Timeout: ${RUNPOD_EXEC_TIMEOUT}s"
    return 0
  fi

  log_info "RunPod Serverless 엔드포인트 생성 중..."

  MUTATION=$(cat <<EOF
mutation {
  saveEndpoint(input: {
    name: "the-circle-comfyui"
    imageName: "${FULL_IMAGE}"
    gpuIds: "${RUNPOD_GPU_IDS}"
    workersMin: ${RUNPOD_MIN_WORKERS}
    workersMax: ${RUNPOD_MAX_WORKERS}
    idleTimeout: ${RUNPOD_IDLE_TIMEOUT}
    executionTimeoutMs: $(( RUNPOD_EXEC_TIMEOUT * 1000 ))
    env: [
      { key: "COMFYUI_DIR", value: "/ComfyUI" }
      { key: "MODEL_DIR", value: "/runpod-volume/models" }
    ]
  }) {
    id
    name
    workersMin
    workersMax
  }
}
EOF
  )

  RESPONSE=$(curl -s \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
    -d "{\"query\": $(echo "$MUTATION" | jq -Rsa .)}" \
    "${RUNPOD_API_URL}")

  if echo "$RESPONSE" | grep -q '"id"'; then
    ENDPOINT_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    log_success "RunPod 엔드포인트 생성 완료!"
    echo ""
    echo "  Endpoint ID: ${ENDPOINT_ID}"
    echo "  다음 환경변수를 .env에 추가하세요:"
    echo "    RUNPOD_ENDPOINT_ID=${ENDPOINT_ID}"
  else
    log_error "RunPod 엔드포인트 생성 실패:"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
  fi
}

# ── RunPod 엔드포인트 업데이트 ────────────────────────────────────────────────
update_runpod_endpoint() {
  if [[ -z "${RUNPOD_API_KEY:-}" ]]; then
    log_warn "RUNPOD_API_KEY가 없습니다. 엔드포인트 업데이트를 건너뜁니다."
    return 0
  fi

  if [[ -z "${RUNPOD_ENDPOINT_ID:-}" ]]; then
    log_error "RUNPOD_ENDPOINT_ID 환경변수를 설정해주세요."
    exit 1
  fi

  log_info "RunPod 엔드포인트 업데이트 중 (ID: ${RUNPOD_ENDPOINT_ID})..."

  MUTATION=$(cat <<EOF
mutation {
  saveEndpoint(input: {
    id: "${RUNPOD_ENDPOINT_ID}"
    imageName: "${FULL_IMAGE}"
    workersMin: ${RUNPOD_MIN_WORKERS}
    workersMax: ${RUNPOD_MAX_WORKERS}
    idleTimeout: ${RUNPOD_IDLE_TIMEOUT}
    executionTimeoutMs: $(( RUNPOD_EXEC_TIMEOUT * 1000 ))
  }) {
    id
    name
  }
}
EOF
  )

  RESPONSE=$(curl -s \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${RUNPOD_API_KEY}" \
    -d "{\"query\": $(echo "$MUTATION" | jq -Rsa .)}" \
    "${RUNPOD_API_URL}")

  if echo "$RESPONSE" | grep -q '"id"'; then
    log_success "RunPod 엔드포인트 업데이트 완료!"
  else
    log_error "RunPod 엔드포인트 업데이트 실패:"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
  fi
}

# ── 메인 ─────────────────────────────────────────────────────────────────────
main() {
  echo "============================================"
  echo "  The Circle — RunPod 배포 스크립트"
  echo "============================================"
  echo ""

  check_requirements

  if [[ "$BUILD" == "true" ]]; then
    build_and_push
  fi

  if [[ "$UPDATE_ENDPOINT" == "true" ]]; then
    update_runpod_endpoint
  elif [[ "$ENDPOINT_ONLY" == "true" ]] || [[ "$BUILD" == "true" ]]; then
    create_runpod_endpoint
  fi

  echo ""
  log_success "배포 완료!"
  echo ""
  echo "다음 단계:"
  echo "  1. RunPod 대시보드에서 엔드포인트 상태 확인"
  echo "  2. Network Volume에 모델 파일 배치 (콜드스타트 방지)"
  echo "     → bash scripts/download_models.sh (RunPod 콘솔에서 실행)"
  echo "  3. 백엔드 .env에 RUNPOD_ENDPOINT_ID 설정"
}

main "$@"
