# The Circle - AI 인테리어 스튜디오

## 프로젝트 개요

방 사진 한 장으로 인테리어를 AI로 변환하는 서비스.
ComfyUI(SDXL) + RunPod Serverless 기반, 브라우저에서 Transformers.js로 실시간 분석.

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| Frontend | React 18, react-router-dom, react-hot-toast |
| Backend | Node.js 20, Express 4, PostgreSQL 16 |
| AI 렌더링 | ComfyUI (SDXL + LoRA + ControlNet + IP-Adapter) |
| 세그멘테이션 | Transformers.js (SegFormer ADE20K + SAM) |
| 배포 | Docker / Docker Compose, RunPod Serverless |

---

## 전체 사용자 흐름 (목표)

```
[Step 1] 방 사진 업로드
  → 백그라운드 자동 실행 (사용자에게 안 보임):
    a. Semantic Segmentation (ADE20K) → 벽/바닥/천장/문/창문 영역 캐싱
    b. SAM 이미지 인코더 임베딩 캐싱
  → "이미지를 분석하고 있습니다..." (3~5초)

[Step 2] 분위기 변환
  → 스타일 프리셋 카드 선택 (재팬디, 워밍미니멀 등)
  → 또는 참조 이미지 업로드 ("이런 느낌으로")
  → IP-Adapter + ControlNet(Depth+Canny)으로 전체 분위기 변환
  → 결과 이미지 표시

[Step 3] 채팅으로 세부 수정
  → 사용자가 한국어로 수정 요청:
      "왼쪽 벽 검은색으로 바꿔줘"
      "바닥 대리석으로 변경해줘"
  → AI가 의도 분석 → 캐싱된 영역 하이라이트
  → "이 영역을 변경할까요?" → [맞아요 ✓] [다시 선택 ✗]
  → [맞아요] → 바로 실행
  → [다시 선택] → 보정 모드 (SAM 수동 조정)

[Step 4] 만족할 때까지 반복
  → 채팅으로 계속 수정
  → 각 수정은 EditLayer로 누적 관리
  → 레이어 on/off, 삭제 가능

[Step 5] 최종 렌더링
  → 조명 선택 (아침/저녁/야간)
  → 고품질 최종 이미지 생성
  → 다운로드/공유
```

---

## 개발 단계 (Phases)

### ✅ Phase 1 - 기반 인프라 (완료)
- 사용자 인증 (로그인/회원가입/OAuth)
- 이미지 업로드 & 프로젝트 관리
- 자재 카탈로그 시스템
- ComfyUI 워크플로우 파이프라인 (로컬 + RunPod)
- 크레딧 시스템 (Free 10 / Pro 200 / Business 1000)
- Docker Compose 전체 실행 환경

### ✅ Phase 2 - 수동 마스킹 & 렌더링 (완료)
- 마스킹 UI (브러시 / 올가미 / 박스 / 포인트)
- SAM (SlimSAM-77) 기반 자동 세그멘테이션
- 스타일 변환 / 자재 적용 / 분위기 이전 / 가구 배치
- Before/After 슬라이더
- 레이어 관리 시스템

### 🔄 Phase 3 - Semantic Segmentation 자동 분석 (진행 예정)
> 채팅 수정의 핵심: 업로드 시점에 전체 영역을 미리 분석·캐싱

**구현 목표:**
- `Xenova/segformer-b2-finetuned-ade-512-512` 모델 사용
- 이미지 업로드 직후 백그라운드에서 자동 실행
- 150개 ADE20K 카테고리 → The Circle 라벨 매핑 (벽/바닥/천장/문/창문/가구)
- 각 영역 마스크 캐싱 → 채팅 요청 시 즉시 반환
- 엣지 스냅 후처리로 경계선 정밀화 (Canny Edge + 15px 스냅 반경)

**핵심 파일:**
```
client/src/lib/segmentation/semanticSegmentation.ts
```

**인터페이스:**
```typescript
class RoomSegmenter {
  async analyzeRoom(imageUrl: string): Promise<Map<string, ImageData>>
  getSegment(label: string): ImageData | null
  getAllSegments(): { label: string, mask: ImageData }[]
}
```

**ADE20K → The Circle 라벨 매핑:**
```
wall      ← ['wall']
floor     ← ['floor', 'flooring']
ceiling   ← ['ceiling']
door      ← ['door']
window    ← ['window', 'windowpane']
furniture ← ['table', 'chair', 'sofa', 'bed', 'desk', 'cabinet', 'shelf']
```

### 🔄 Phase 4 - 채팅 기반 수정 시스템 (진행 예정)
> 자연어로 인테리어를 수정하는 핵심 UX

**구현 목표:**
- 변환된 이미지 아래 채팅 입력창 UI
- 한국어 의도 분석 → 영역 자동 매핑
  - "벽 바꿔줘" → `wall` 세그먼트 하이라이트
  - "바닥 대리석" → `floor` 세그먼트 + 자재 적용
  - "가구 넣어줘" → 가구 배치 모드
- 영역 확인 UI: "이 영역을 변경할까요?" → [맞아요 / 다시 선택]
- [다시 선택] 시 SAM 보정 모드 진입
- EditLayer 누적 관리 (각 수정을 레이어로 쌓기)
- 레이어별 on/off, 삭제, 순서 변경

**의도 분석 키워드 매핑 (예시):**
```
벽/월/wall → segment: wall
바닥/플로어/floor → segment: floor
천장/ceiling → segment: ceiling
밝게/어둡게/조명 → action: lighting
가구/소파/책상 → action: furniture
```

### 🔄 Phase 5 - 최종 렌더링 & 마무리 (진행 예정)
> 고품질 최종 출력물 생성

**구현 목표:**
- 조명 프리셋 선택 UI (아침 / 저녁 / 야간)
- SDXL Base → Refiner 2단계 파이프라인 (`final_render` 워크플로우)
- 업스케일링 옵션 (2x / 4x)
- 결과물 다운로드 (JPG/PNG 선택)
- 공유 기능 (링크 생성)
- RunPod 연동 실제 서비스 테스트

---

## ComfyUI 워크플로우 (5개)

| 워크플로우 | 설명 | 모델 |
|-----------|------|------|
| `circle_ai` | 전체 룸 스타일 변환 | SDXL + LoRA + ControlNet Canny |
| `material_apply` | 재질/텍스처 적용 | SDXL + IP-Adapter + ControlNet Depth |
| `mood_copy` | 분위기/조명 이전 | SDXL + IP-Adapter |
| `furniture_place` | 가구 배치 | SDXL Inpainting |
| `final_render` | 최종 고품질 렌더 | SDXL Base → Refiner → Upscale |

> **워크플로우 제작 순서:**
> 1. ComfyUI UI에서 직접 구성 & 테스트
> 2. `Save (API Format)`으로 JSON 추출
> 3. `server/workflows/` 폴더에 저장
> 4. `*.config.json`으로 injection 포인트 (이미지/프롬프트/시드 노드 ID) 명시

---

## RunPod 설정

```env
RUNPOD_API_KEY=rpa_xxxxxxxxxxxx
RUNPOD_COMFYUI_ENDPOINT_ID=your_comfyui_endpoint_id
RUNPOD_REMBG_ENDPOINT_ID=your_rembg_endpoint_id
```

**필요 모델 (RunPod 볼륨에 사전 탑재):**
- `sdxl_base_1.0.safetensors`
- `sdxl_refiner_1.0.safetensors`
- `korea-apartment-style_v1.safetensors` (LoRA)
- ControlNet SDXL (Canny + Depth)
- IP-Adapter (`ip-adapter-plus_sdxl_vit-h.bin`)

---

## 로컬 개발 실행

```bash
# 전체 실행 (Docker Compose)
cp .env.example .env
docker-compose up --build

# Frontend: http://localhost:3000
# Backend:  http://localhost:4000
```

### 로컬 ComfyUI 테스트 시
- `server/workflows/interior.json` → 현재 SD1.5 inpainting (로컬 테스트용)
- RunPod 테스트 시 → SDXL 워크플로우로 전환 필요
