#!/usr/bin/env bash
# =============================================================================
#  dev.sh — The Circle 로컬 개발 서버 통합 실행 스크립트
#
#  사용법:
#    ./dev.sh           # 전체 시작 (DB + 백엔드 + 프론트엔드)
#    ./dev.sh start     # 위와 동일
#    ./dev.sh stop      # 전체 종료
#    ./dev.sh restart   # 전체 재시작
#    ./dev.sh status    # 실행 상태 확인
#    ./dev.sh logs      # 실시간 로그 (백엔드 + 프론트엔드)
#    ./dev.sh logs be   # 백엔드 로그만
#    ./dev.sh logs fe   # 프론트엔드 로그만
#    ./dev.sh db        # DB(Docker)만 시작
#    ./dev.sh be        # 백엔드만 시작
#    ./dev.sh fe        # 프론트엔드만 시작
# =============================================================================
set -euo pipefail

# ── 경로 설정 ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
FRONTEND_DIR="$SCRIPT_DIR/client"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.dev.yml"

LOG_DIR="$SCRIPT_DIR/.dev_logs"
PID_FILE="$SCRIPT_DIR/.dev_pids"
BE_LOG="$LOG_DIR/backend.log"
FE_LOG="$LOG_DIR/frontend.log"

BE_PORT=4000
FE_PORT=3000
DB_PORT=5432

# ── ANSI 색상 ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  R="\033[31m" G="\033[32m" Y="\033[33m" B="\033[34m" C="\033[36m"
  BOLD="\033[1m" DIM="\033[2m" RST="\033[0m"
else
  R="" G="" Y="" B="" C="" BOLD="" DIM="" RST=""
fi

# ── 헬퍼 함수 ─────────────────────────────────────────────────────────────────
log()  { echo -e "${DIM}[$(date '+%H:%M:%S')]${RST} $*"; }
info() { echo -e "${B}[INFO]${RST} $*"; }
ok()   { echo -e "${G}[ OK ]${RST} $*"; }
warn() { echo -e "${Y}[WARN]${RST} $*"; }
err()  { echo -e "${R}[ERR ]${RST} $*" >&2; }
die()  { err "$*"; exit 1; }

header() {
  echo
  echo -e "${BOLD}${C}══════════════════════════════════════════${RST}"
  echo -e "${BOLD}${C}  The Circle — 개발 서버${RST}  $*"
  echo -e "${BOLD}${C}══════════════════════════════════════════${RST}"
  echo
}

# PID 파일 읽기
_pid_be() { [[ -f "$PID_FILE" ]] && awk '/^BE=/{print substr($0,4)}' "$PID_FILE" || echo ""; }
_pid_fe() { [[ -f "$PID_FILE" ]] && awk '/^FE=/{print substr($0,4)}' "$PID_FILE" || echo ""; }

# 프로세스 살아있는지 확인
_alive() { [[ -n "$1" ]] && kill -0 "$1" 2>/dev/null; }

# 포트 사용 중인지 확인
_port_used() { lsof -ti :"$1" > /dev/null 2>&1; }

# 로그 디렉토리 생성
_mk_logs() { mkdir -p "$LOG_DIR"; }

# ── 개별 시작 함수 ──────────────────────────────────────────────────────────────

start_db() {
  info "DB(PostgreSQL) 시작 중..."

  if ! command -v docker &>/dev/null; then
    warn "Docker가 설치되지 않았습니다 — DB 건너뜀"
    return 0
  fi

  if [[ ! -f "$COMPOSE_FILE" ]]; then
    warn "docker-compose.dev.yml 없음 — DB 건너뜀"
    return 0
  fi

  docker compose -f "$COMPOSE_FILE" up -d --quiet-pull 2>&1 | \
    sed "s/^/  ${DIM}[docker]${RST} /"

  # 헬스체크 대기 (최대 20초)
  local i=0
  while ! docker compose -f "$COMPOSE_FILE" exec -T db \
        pg_isready -U circle_user -d the_circle &>/dev/null; do
    ((i++))
    [[ $i -ge 20 ]] && { warn "DB 헬스체크 타임아웃 (계속 진행)"; break; }
    sleep 1
    printf "."
  done
  [[ $i -gt 0 ]] && echo

  ok "DB 준비 완료 (localhost:${DB_PORT})"
}

start_backend() {
  local pid
  pid=$(_pid_be)
  if _alive "$pid"; then
    warn "백엔드 이미 실행 중 (PID $pid)"
    return 0
  fi

  if [[ ! -d "$BACKEND_DIR" ]]; then
    die "backend/ 디렉토리를 찾을 수 없습니다"
  fi

  # Python venv 탐지
  local python="python3"
  for candidate in \
    "$BACKEND_DIR/.venv/bin/python" \
    "$BACKEND_DIR/venv/bin/python" \
    "$SCRIPT_DIR/.venv/bin/python"; do
    if [[ -x "$candidate" ]]; then
      python="$candidate"
      break
    fi
  done

  # .env 파일 확인
  if [[ ! -f "$BACKEND_DIR/.env" ]]; then
    warn "backend/.env 없음. backend/.env.example을 복사합니다."
    cp "$BACKEND_DIR/.env.example" "$BACKEND_DIR/.env"
  fi

  _mk_logs
  info "백엔드 시작 중 (포트 $BE_PORT)..."

  (
    cd "$BACKEND_DIR"
    export PYTHONUNBUFFERED=1
    # shellcheck disable=SC1091
    [[ -f .env ]] && set -a && source .env && set +a
    "$python" -m uvicorn app.main:app \
      --reload \
      --host 0.0.0.0 \
      --port "$BE_PORT" \
      2>&1
  ) >> "$BE_LOG" 2>&1 &

  local be_pid=$!
  # PID 파일 업데이트
  _save_pid BE "$be_pid"

  # 기동 확인 (최대 10초)
  local i=0
  while ! _port_used "$BE_PORT"; do
    ((i++))
    [[ $i -ge 20 ]] && { warn "백엔드 기동 확인 타임아웃 (로그 확인: $BE_LOG)"; return 0; }
    sleep 0.5
  done

  ok "백엔드 실행 중 (PID $be_pid) → http://localhost:$BE_PORT"
  ok "  API 문서: http://localhost:$BE_PORT/docs"
}

start_frontend() {
  local pid
  pid=$(_pid_fe)
  if _alive "$pid"; then
    warn "프론트엔드 이미 실행 중 (PID $pid)"
    return 0
  fi

  if [[ ! -d "$FRONTEND_DIR" ]]; then
    die "client/ 디렉토리를 찾을 수 없습니다"
  fi

  # node_modules 확인
  if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
    info "node_modules 없음 — npm install 실행 중..."
    (cd "$FRONTEND_DIR" && npm install --silent) || die "npm install 실패"
  fi

  # .env 없으면 .env.example에서 복사 (BROWSER=none 포함)
  if [[ ! -f "$FRONTEND_DIR/.env" ]] && [[ -f "$FRONTEND_DIR/.env.example" ]]; then
    cp "$FRONTEND_DIR/.env.example" "$FRONTEND_DIR/.env"
    info "client/.env 생성됨 (from .env.example)"
  fi

  _mk_logs
  info "프론트엔드 시작 중 (포트 $FE_PORT)..."

  (
    cd "$FRONTEND_DIR"
    export BROWSER=none        # 자동 브라우저 열기 방지
    export REACT_APP_BROWSER=none
    export FORCE_COLOR=1       # 컬러 로그 유지
    # VS Code 터미널에서 내부 브라우저로 열리는 것 방지
    unset VSCODE_GIT_IPC_HANDLE 2>/dev/null || true
    npm start 2>&1
  ) >> "$FE_LOG" 2>&1 &

  local fe_pid=$!
  _save_pid FE "$fe_pid"

  # 기동 확인 (최대 30초 — CRA는 느림)
  local i=0
  while ! _port_used "$FE_PORT"; do
    ((i++))
    [[ $i -ge 60 ]] && { warn "프론트엔드 기동 확인 타임아웃 (로그 확인: $FE_LOG)"; return 0; }
    sleep 0.5
  done

  ok "프론트엔드 실행 중 (PID $fe_pid) → http://localhost:$FE_PORT"
}

# ── PID 파일 관리 ──────────────────────────────────────────────────────────────

_save_pid() {
  local key="$1" val="$2"
  # 기존 항목 제거 후 추가
  local tmp; tmp=$(mktemp)
  [[ -f "$PID_FILE" ]] && grep -v "^${key}=" "$PID_FILE" > "$tmp" || true
  echo "${key}=${val}" >> "$tmp"
  mv "$tmp" "$PID_FILE"
}

_clear_pid() {
  local key="$1"
  if [[ -f "$PID_FILE" ]]; then
    local tmp; tmp=$(mktemp)
    grep -v "^${key}=" "$PID_FILE" > "$tmp" || true
    mv "$tmp" "$PID_FILE"
  fi
}

# ── 종료 함수 ─────────────────────────────────────────────────────────────────

stop_backend() {
  local pid; pid=$(_pid_be)
  if _alive "$pid"; then
    info "백엔드 종료 중 (PID $pid)..."
    # uvicorn --reload는 자식 워커를 spawn하므로 프로세스 그룹 종료
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    local i=0
    while _alive "$pid"; do
      ((i++)); [[ $i -ge 10 ]] && { kill -9 "$pid" 2>/dev/null || true; break; }
      sleep 0.5
    done
    ok "백엔드 종료됨"
  else
    info "백엔드 실행 중이 아닙니다"
  fi
  # 포트에 남아있는 프로세스 정리
  local lingering; lingering=$(lsof -ti :"$BE_PORT" 2>/dev/null || true)
  [[ -n "$lingering" ]] && kill "$lingering" 2>/dev/null || true
  _clear_pid BE
}

stop_frontend() {
  local pid; pid=$(_pid_fe)
  if _alive "$pid"; then
    info "프론트엔드 종료 중 (PID $pid)..."
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    local i=0
    while _alive "$pid"; do
      ((i++)); [[ $i -ge 10 ]] && { kill -9 "$pid" 2>/dev/null || true; break; }
      sleep 0.5
    done
    ok "프론트엔드 종료됨"
  else
    info "프론트엔드 실행 중이 아닙니다"
  fi
  local lingering; lingering=$(lsof -ti :"$FE_PORT" 2>/dev/null || true)
  [[ -n "$lingering" ]] && kill "$lingering" 2>/dev/null || true
  _clear_pid FE
}

stop_db() {
  if ! command -v docker &>/dev/null || [[ ! -f "$COMPOSE_FILE" ]]; then
    return 0
  fi
  info "DB 종료 중..."
  docker compose -f "$COMPOSE_FILE" down 2>&1 | \
    sed "s/^/  ${DIM}[docker]${RST} /" || true
  ok "DB 종료됨"
}

# ── 상태 확인 ─────────────────────────────────────────────────────────────────

cmd_status() {
  echo
  echo -e "${BOLD}  서비스 상태${RST}"
  echo -e "  ─────────────────────────────────"

  # DB
  local db_status="${R}정지${RST}"
  if command -v docker &>/dev/null && [[ -f "$COMPOSE_FILE" ]]; then
    if docker compose -f "$COMPOSE_FILE" exec -T db \
        pg_isready -U circle_user &>/dev/null 2>&1; then
      db_status="${G}실행 중${RST} (localhost:$DB_PORT)"
    fi
  fi
  printf "  %-14s %b\n" "DB (Postgres)" "$db_status"

  # 백엔드
  local be_pid; be_pid=$(_pid_be)
  local be_status
  if _alive "$be_pid"; then
    be_status="${G}실행 중${RST} (PID $be_pid, localhost:$BE_PORT)"
  elif _port_used "$BE_PORT"; then
    be_status="${Y}포트 사용 중${RST} (PID 불명, localhost:$BE_PORT)"
  else
    be_status="${R}정지${RST}"
  fi
  printf "  %-14s %b\n" "백엔드" "$be_status"

  # 프론트엔드
  local fe_pid; fe_pid=$(_pid_fe)
  local fe_status
  if _alive "$fe_pid"; then
    fe_status="${G}실행 중${RST} (PID $fe_pid, localhost:$FE_PORT)"
  elif _port_used "$FE_PORT"; then
    fe_status="${Y}포트 사용 중${RST} (PID 불명, localhost:$FE_PORT)"
  else
    fe_status="${R}정지${RST}"
  fi
  printf "  %-14s %b\n" "프론트엔드" "$fe_status"

  echo -e "  ─────────────────────────────────"
  echo -e "  로그 위치: ${DIM}$LOG_DIR/${RST}"
  echo
}

# ── 로그 보기 ─────────────────────────────────────────────────────────────────

cmd_logs() {
  local target="${1:-both}"
  _mk_logs
  touch "$BE_LOG" "$FE_LOG"

  case "$target" in
    be|backend)
      info "백엔드 로그 (Ctrl+C로 종료)"
      tail -f "$BE_LOG"
      ;;
    fe|frontend)
      info "프론트엔드 로그 (Ctrl+C로 종료)"
      tail -f "$FE_LOG"
      ;;
    *)
      info "백엔드 + 프론트엔드 로그 (Ctrl+C로 종료)"
      # tail --pid가 없는 경우를 위해 단순 tail -f 두 파일
      tail -f "$BE_LOG" "$FE_LOG"
      ;;
  esac
}

# ── 메인 커맨드 ───────────────────────────────────────────────────────────────

cmd_start() {
  header "시작"
  start_db
  echo
  start_backend
  echo
  start_frontend
  echo
  cmd_status
  echo -e "  ${G}${BOLD}모두 준비됐습니다!${RST}"
  echo -e "  프론트엔드  → ${C}http://localhost:$FE_PORT${RST}"
  echo -e "  백엔드 API  → ${C}http://localhost:$BE_PORT/docs${RST}"
  echo
  echo -e "  ${DIM}종료하려면: ./dev.sh stop${RST}"
  echo
}

cmd_stop() {
  header "종료"
  stop_frontend
  echo
  stop_backend
  echo
  stop_db
  echo
  ok "모든 서비스가 종료됐습니다"
  echo
}

cmd_restart() {
  cmd_stop
  sleep 1
  cmd_start
}

cmd_help() {
  echo
  echo -e "${BOLD}사용법:${RST}  ./dev.sh [커맨드]"
  echo
  echo -e "${BOLD}커맨드:${RST}"
  echo -e "  ${G}start${RST}       DB + 백엔드 + 프론트엔드 모두 시작 (기본)"
  echo -e "  ${R}stop${RST}        모두 종료"
  echo -e "  ${Y}restart${RST}     재시작"
  echo -e "  ${C}status${RST}      실행 상태 확인"
  echo -e "  ${C}logs${RST}        실시간 전체 로그"
  echo -e "  ${C}logs be${RST}     백엔드 로그만"
  echo -e "  ${C}logs fe${RST}     프론트엔드 로그만"
  echo -e "  ${B}db${RST}          DB(Docker)만 시작"
  echo -e "  ${B}be${RST}          백엔드만 시작"
  echo -e "  ${B}fe${RST}          프론트엔드만 시작"
  echo
  echo -e "${BOLD}로그 파일:${RST}"
  echo -e "  백엔드     $LOG_DIR/backend.log"
  echo -e "  프론트엔드 $LOG_DIR/frontend.log"
  echo
}

# ── 진입점 ────────────────────────────────────────────────────────────────────

main() {
  local cmd="${1:-start}"
  case "$cmd" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_restart ;;
    status)  cmd_status ;;
    logs)    cmd_logs "${2:-both}" ;;
    db)      start_db ;;
    be)      start_backend ;;
    fe)      start_frontend ;;
    help|-h|--help) cmd_help ;;
    *)
      err "알 수 없는 커맨드: $cmd"
      cmd_help
      exit 1
      ;;
  esac
}

main "$@"
