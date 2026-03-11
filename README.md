# AI 아파트 인테리어 렌더링 서비스

ComfyUI + RunPod Serverless를 이용한 AI 인테리어 렌더링 서비스입니다.

## 기술 스택

| 영역 | 기술 |
|------|------|
| Frontend | React 18, react-router-dom, react-hot-toast |
| Backend | Node.js 20, Express 4 |
| Database | PostgreSQL 16 |
| AI 렌더링 | ComfyUI (ControlNet + LoRA + IP-Adapter + Inpainting) |
| 누끼 제거 | rembg (RunPod Serverless) |
| 배포 | Docker / Docker Compose |

## 프로젝트 구조

```
.
├── client/                  # React 앱
│   ├── src/
│   │   ├── pages/
│   │   │   ├── UploadPage.js        # 1단계: 이미지 업로드
│   │   │   ├── StyleSelectPage.js   # 2단계: 스타일 & 자재 선택
│   │   │   ├── MaskingPage.js       # 3단계: 마스킹 (캔버스)
│   │   │   └── ResultPage.js        # 4단계: 결과 확인 + 비교 슬라이더
│   │   ├── components/
│   │   │   └── Header.js            # 스텝 네비게이션 헤더
│   │   ├── hooks/
│   │   │   └── useAppState.js       # localStorage 기반 전역 상태
│   │   └── utils/
│   │       └── api.js               # Axios API 클라이언트
│   └── Dockerfile
├── server/                  # Express 앱
│   ├── src/
│   │   ├── index.js                 # 앱 진입점
│   │   ├── routes/
│   │   │   ├── upload.js            # POST /api/upload
│   │   │   ├── removeBg.js          # POST /api/remove-bg
│   │   │   ├── render.js            # POST /api/render, GET /api/render/:jobId
│   │   │   ├── materials.js         # GET /api/materials
│   │   │   └── orders.js            # POST/GET /api/orders
│   │   ├── db/
│   │   │   ├── index.js             # DB 연결 & 초기화
│   │   │   ├── schema.sql           # 테이블 스키마
│   │   │   └── seed.sql             # 자재 시드 데이터
│   │   ├── middleware/
│   │   │   └── errorHandler.js
│   │   └── utils/
│   │       ├── runpod.js            # RunPod API 래퍼
│   │       ├── promptBuilder.js     # 한국어 선택 → 영문 프롬프트 변환
│   │       └── comfyWorkflow.js     # ComfyUI 워크플로우 JSON 조립
│   └── Dockerfile
├── runpod/                  # RunPod 핸들러 스크립트
│   ├── rembg_handler.py     # 배경 제거 핸들러
│   ├── rembg_Dockerfile
│   ├── rembg_requirements.txt
│   ├── comfyui_handler.py   # ComfyUI 렌더링 핸들러
│   ├── comfyui_Dockerfile
│   ├── comfyui_requirements.txt
│   └── comfyui_start.sh
├── docker-compose.yml
└── .env.example
```

## 로컬 실행 방법

### 사전 준비

- Node.js 20+
- Python 3.10+
- PostgreSQL 16 (또는 Docker)
- RunPod 계정 및 API 키

### 1. 환경변수 설정

```bash
cp .env.example server/.env
```

`server/.env` 파일을 열어 필요한 값을 입력합니다:

```env
PORT=4000
DATABASE_URL=postgresql://user:password@localhost:5432/interior_db
RUNPOD_API_KEY=rpa_xxxxxxxxxxxx
RUNPOD_REMBG_ENDPOINT_ID=your_rembg_endpoint_id
RUNPOD_COMFYUI_ENDPOINT_ID=your_comfyui_endpoint_id
UPLOAD_DIR=./uploads
```

### 2. Docker Compose로 전체 실행 (권장)

```bash
# .env 파일을 프로젝트 루트에 복사
cp .env.example .env
# 환경변수 입력 후:
docker-compose up --build
```

- Frontend: http://localhost:3000
- Backend API: http://localhost:4000
- PostgreSQL: localhost:5432

### 3. 개발 모드 (개별 실행)

#### PostgreSQL 실행

```bash
docker run -d \
  --name interior-db \
  -e POSTGRES_DB=interior_db \
  -e POSTGRES_USER=user \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:16-alpine
```

#### Backend 실행

```bash
cd server
npm install
cp ../.env.example .env  # 환경변수 편집
npm run dev              # nodemon으로 개발 서버 시작
```

#### Frontend 실행

```bash
cd client
npm install
npm start                # http://localhost:3000
```

React 개발 서버는 `package.json`의 `"proxy": "http://localhost:4000"` 설정으로 API 요청을 백엔드로 자동 프록시합니다.

---

## RunPod 배포 방법

### rembg 엔드포인트 배포

1. Docker 이미지 빌드 & 푸시

```bash
cd runpod
docker build -f rembg_Dockerfile -t your-registry/rembg-handler:latest .
docker push your-registry/rembg-handler:latest
```

2. RunPod Serverless 콘솔에서:
   - **+ New Endpoint** 클릭
   - Container Image: `your-registry/rembg-handler:latest`
   - GPU: RTX 3090 이상 권장 (CPU도 동작, 느림)
   - 생성된 Endpoint ID를 `RUNPOD_REMBG_ENDPOINT_ID`에 입력

### ComfyUI 엔드포인트 배포

1. LoRA 모델 준비

   `korea-apartment-style_v1.safetensors` 파일을 준비하여 Docker 이미지에 포함하거나,
   RunPod Network Volume에 마운트합니다.

   ```dockerfile
   # comfyui_Dockerfile에서 주석 해제 후 URL 변경
   RUN wget -O models/loras/korea-apartment-style_v1.safetensors "YOUR_LORA_URL"
   ```

2. Docker 이미지 빌드 & 푸시

```bash
docker build -f comfyui_Dockerfile -t your-registry/comfyui-handler:latest .
docker push your-registry/comfyui-handler:latest
```

3. RunPod Serverless 콘솔에서:
   - **+ New Endpoint** 클릭
   - Container Image: `your-registry/comfyui-handler:latest`
   - GPU: RTX 4090 / A100 권장 (VRAM 16GB 이상)
   - Max Workers: 2~3
   - 생성된 Endpoint ID를 `RUNPOD_COMFYUI_ENDPOINT_ID`에 입력

### Network Volume 사용 (모델 공유)

큰 모델 파일을 여러 워커가 공유하려면 RunPod Network Volume 사용을 권장합니다:

1. RunPod 콘솔 → Storage → **Create Volume** (50GB 이상)
2. 볼륨에 모델 파일 업로드 (`/runpod-volume/ComfyUI/models/`)
3. Endpoint 설정에서 Volume Mount 추가

---

## API 엔드포인트

| 메서드 | 경로 | 설명 |
|--------|------|------|
| `POST` | `/api/upload` | 이미지 업로드 |
| `POST` | `/api/remove-bg` | 배경 자동 제거 (rembg) |
| `POST` | `/api/render` | AI 렌더링 시작 |
| `GET` | `/api/render/:jobId` | 렌더링 상태 폴링 |
| `GET` | `/api/materials` | 자재 목록 조회 |
| `POST` | `/api/orders` | 주문 저장 |
| `GET` | `/api/health` | 서버 상태 확인 |

---

## ComfyUI AI 파이프라인

```
원본 이미지
    ↓
ControlNet (Depth) ──── 구조 보존
    ↓
LoRA (korea-apartment-style_v1) ──── 한국 아파트 스타일
    ↓
IP-Adapter (자재 텍스처) ──── 선택한 자재 텍스처 이식
    ↓
Inpainting KSampler ──── 마스크 영역만 생성
    ↓
VAE Decode → 결과 이미지
```

---

## 데이터베이스 스키마

```sql
users          -- 사용자
materials      -- 자재 카탈로그
orders         -- 렌더링 주문
render_results -- RunPod 작업 결과
```

---

## 문제 해결

### 업로드가 안 될 때
- `UPLOAD_DIR` 경로의 쓰기 권한 확인
- 파일 크기 20MB 제한 확인

### RunPod 타임아웃
- ComfyUI 워커 수 증가 (Max Workers)
- Network Volume으로 모델 로딩 시간 단축

### CORS 오류
- 개발: `client/package.json`의 `proxy` 설정 확인
- 프로덕션: nginx 리버스 프록시 설정 확인
