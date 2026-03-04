"""
cubemap.py
──────────
360도 등장방형도법(Equirectangular) ↔ 큐브맵 6면 상호 변환 모듈

좌표계 규약 (오른손 좌표계):
  +X = 우(Right), +Y = 위(Top), +Z = 앞(Front)
  경도(lon) 0 = 정면(+Z), +π/2 = 우측(+X)
  위도(lat) 0 = 수평, +π/2 = 위(+Y)

면 인덱스 순서:
  0 = front (+Z)
  1 = back  (-Z)
  2 = right (+X)
  3 = left  (-X)
  4 = top   (+Y)
  5 = bottom(-Y)
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Tuple

import cv2
import numpy as np

# 면 이름 (인덱스 순서와 일치)
FACE_NAMES: List[str] = ["front", "back", "right", "left", "top", "bottom"]


# ──────────────────────────────────────────────
# 내부 헬퍼: 등장방형도법 조회 테이블 생성
# ──────────────────────────────────────────────

def _build_equirect_to_face_map(
    face_idx: int,
    face_size: int,
    eq_w: int,
    eq_h: int,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    큐브맵 면(face_idx) 의 각 픽셀이 등장방형도법 어느 좌표에서 샘플링돼야
    하는지 나타내는 (map_x, map_y) 룩업 테이블을 생성한다.
    cv2.remap() 에 직접 전달 가능한 float32 배열을 반환한다.

    수식 개요
    ---------
    1. 면 픽셀 (j, i) → 정규화 좌표 (u, v) ∈ (-1, 1)
    2. (u, v) + 면 정의 → 3D 방향 벡터 (x, y, z)
    3. 단위벡터 정규화
    4. (x, y, z) → 구면좌표 (lon, lat)
    5. (lon, lat) → 등장방형도법 픽셀 (map_x, map_y)
    """
    # 면 픽셀 좌표 그리드
    j = np.arange(face_size, dtype=np.float32)
    i = np.arange(face_size, dtype=np.float32)
    # u: 열 방향 → 좌(-1) ~ 우(+1)
    # v: 행 방향 → 위(-1) ~ 아래(+1)
    u, v = np.meshgrid(
        (j + 0.5) / face_size * 2.0 - 1.0,
        (i + 0.5) / face_size * 2.0 - 1.0,
    )

    ones = np.ones_like(u)

    # 각 면에 해당하는 3D 방향 벡터 (x, y, z) 정의
    # 검증: face_idx=0(Front), u=0 v=0 → (0,0,1) → lon=0 lat=0 ✓
    if face_idx == 0:    # Front (+Z): 앞면
        x, y, z = u.copy(), -v, ones
    elif face_idx == 1:  # Back  (-Z): 뒷면
        x, y, z = -u, -v, -ones
    elif face_idx == 2:  # Right (+X): 우측면
        x, y, z = ones, -v, -u
    elif face_idx == 3:  # Left  (-X): 좌측면
        x, y, z = -ones, -v, u.copy()
    elif face_idx == 4:  # Top   (+Y): 윗면
        x, y, z = u.copy(), ones, v.copy()
    elif face_idx == 5:  # Bottom(-Y): 아랫면
        x, y, z = u.copy(), -ones, -v
    else:
        raise ValueError(f"face_idx 는 0~5 이어야 합니다. 입력값: {face_idx}")

    # 단위벡터 정규화
    norm = np.sqrt(x ** 2 + y ** 2 + z ** 2)
    x, y, z = x / norm, y / norm, z / norm

    # 구면좌표 변환
    lon = np.arctan2(x, z)                    # 경도 [-π, π]
    lat = np.arcsin(np.clip(y, -1.0, 1.0))   # 위도 [-π/2, π/2]

    # 등장방형도법 픽셀 좌표 (0-based, 소수점 포함)
    # lon=0 → 중앙(W/2), lat=0 → 중앙(H/2)
    map_x = (lon / (2.0 * np.pi) + 0.5) * eq_w - 0.5
    map_y = (0.5 - lat / np.pi) * eq_h - 0.5

    return map_x.astype(np.float32), map_y.astype(np.float32)


# ──────────────────────────────────────────────
# 공개 API: 등장방형도법 → 큐브맵
# ──────────────────────────────────────────────

def equirect_to_cubemap(
    equirect: np.ndarray,
    face_size: int = 512,
) -> List[np.ndarray]:
    """
    등장방형도법 이미지를 큐브맵 6면으로 분할한다.

    Parameters
    ----------
    equirect : np.ndarray
        H×W×3 BGR 이미지. 권장 비율 2:1 (예: 4096×2048).
    face_size : int
        각 면 이미지의 픽셀 크기 (정방형).

    Returns
    -------
    List[np.ndarray]
        [front, back, right, left, top, bottom] 순서의 6장 face_size×face_size BGR 이미지.
    """
    eq_h, eq_w = equirect.shape[:2]
    faces: List[np.ndarray] = []

    for face_idx in range(6):
        map_x, map_y = _build_equirect_to_face_map(face_idx, face_size, eq_w, eq_h)
        face = cv2.remap(
            equirect,
            map_x,
            map_y,
            interpolation=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_WRAP,   # 경도 방향 순환 처리
        )
        faces.append(face)

    return faces


# ──────────────────────────────────────────────
# 공개 API: 큐브맵 → 등장방형도법
# ──────────────────────────────────────────────

def cubemap_to_equirect(
    faces: List[np.ndarray],
    output_size: Tuple[int, int] | None = None,
) -> np.ndarray:
    """
    큐브맵 6면을 등장방형도법으로 병합한다.

    Parameters
    ----------
    faces : List[np.ndarray]
        [front, back, right, left, top, bottom] 순서의 BGR 이미지 6장.
        모든 면은 동일한 정방형 크기여야 한다.
    output_size : (H, W) | None
        출력 해상도. None 이면 (face_size*2, face_size*4) 를 사용.

    Returns
    -------
    np.ndarray
        H×W×3 BGR 등장방형도법 이미지.
    """
    assert len(faces) == 6, "6장의 face 이미지가 필요합니다."
    face_size = faces[0].shape[0]

    if output_size is None:
        output_size = (face_size * 2, face_size * 4)

    H_out, W_out = output_size
    dtype = faces[0].dtype

    # 출력 픽셀 전체에 대한 3D 방향 벡터 사전 계산
    cols = np.arange(W_out, dtype=np.float32)
    rows = np.arange(H_out, dtype=np.float32)
    col_grid, row_grid = np.meshgrid(cols, rows)

    lon = (col_grid / W_out - 0.5) * (2.0 * np.pi)   # [-π, π]
    lat = (0.5 - row_grid / H_out) * np.pi            # [π/2, -π/2]

    xd = (np.cos(lat) * np.sin(lon)).astype(np.float32)
    yd = np.sin(lat).astype(np.float32)
    zd = (np.cos(lat) * np.cos(lon)).astype(np.float32)

    ax, ay, az = np.abs(xd), np.abs(yd), np.abs(zd)

    # 각 면에 대한 (픽셀 마스크, u 식, v 식) 정의
    # u, v ∈ [-1, 1] → 면 픽셀 col/row = (uv + 1) / 2 * face_size
    #
    # 역산 검증 (face 0, front +Z): 순방향 d=(u,-v,1)
    #   x=u·k, y=-v·k, z=k  (k>0) → u=x/z, v=-y/z  ✓
    face_configs = [
        # 0 Front (+Z): z 지배, z > 0
        (
            (az >= ax) & (az >= ay) & (zd > 0),
            xd / zd,
            -yd / zd,
        ),
        # 1 Back (-Z): z 지배, z < 0  → 순방향 d=(-u,-v,-1)
        #   x=-u·|z|, y=-v·|z| → u=-x/|z|=x/z(z<0), v=-y/|z|=y/z(z<0)
        (
            (az >= ax) & (az >= ay) & (zd <= 0),
            -xd / (-zd),
            -yd / (-zd),
        ),
        # 2 Right (+X): x 지배, x > 0  → 순방향 d=(1,-v,-u)
        #   y=-v·x, z=-u·x → u=-z/x, v=-y/x
        (
            (ax > az) & (ax >= ay) & (xd > 0),
            -zd / xd,
            -yd / xd,
        ),
        # 3 Left (-X): x 지배, x < 0  → 순방향 d=(-1,-v,u)
        #   y=-v·|x|, z=u·|x| → u=z/|x|=-z/x(x<0), v=-y/|x|=y/x(x<0)
        (
            (ax > az) & (ax >= ay) & (xd <= 0),
            zd / (-xd),
            -yd / (-xd),
        ),
        # 4 Top (+Y): y 지배, y > 0  → 순방향 d=(u,1,v)
        #   x=u·y, z=v·y → u=x/y, v=z/y
        (
            (ay > az) & (ay > ax) & (yd > 0),
            xd / yd,
            zd / yd,
        ),
        # 5 Bottom (-Y): y 지배, y < 0  → 순방향 d=(u,-1,-v)
        #   x=u·|y|, z=-v·|y| → u=x/|y|=-x/y(y<0), v=-z/|y|=z/y(y<0)
        (
            (ay > az) & (ay > ax) & (yd <= 0),
            xd / (-yd),
            -zd / (-yd),
        ),
    ]

    # float32 누적 버퍼 (bilinear 보간용)
    result = np.zeros((H_out, W_out, 3), dtype=np.float32)

    for face_idx, (mask, u_expr, v_expr) in enumerate(face_configs):
        if not np.any(mask):
            continue

        face_f = faces[face_idx].astype(np.float32)

        # u, v → 소수점 픽셀 좌표 (clamp)
        fx = np.clip((u_expr[mask] + 1.0) * 0.5 * face_size, 0.0, face_size - 1.0)
        fy = np.clip((v_expr[mask] + 1.0) * 0.5 * face_size, 0.0, face_size - 1.0)

        # Bilinear 보간
        x0 = np.floor(fx).astype(np.int32)
        y0 = np.floor(fy).astype(np.int32)
        x1 = np.clip(x0 + 1, 0, face_size - 1)
        y1 = np.clip(y0 + 1, 0, face_size - 1)
        dx = (fx - x0)[..., np.newaxis]   # (N, 1) 브로드캐스트
        dy = (fy - y0)[..., np.newaxis]

        interpolated = (
            face_f[y0, x0] * (1 - dx) * (1 - dy)
            + face_f[y0, x1] * dx * (1 - dy)
            + face_f[y1, x0] * (1 - dx) * dy
            + face_f[y1, x1] * dx * dy
        )
        result[mask] = interpolated

    return np.clip(result, 0, 255).astype(dtype)


# ──────────────────────────────────────────────
# 파일 입출력 편의 함수
# ──────────────────────────────────────────────

def load_equirect(path: str) -> np.ndarray:
    """등장방형도법 이미지를 BGR numpy 배열로 로드한다."""
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    if img is None:
        raise FileNotFoundError(f"이미지를 열 수 없습니다: {path}")
    return img


def save_equirect(img: np.ndarray, path: str) -> None:
    """등장방형도법 이미지를 저장한다."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(path, img)


def save_faces(
    faces: List[np.ndarray],
    output_dir: str,
    prefix: str = "face",
) -> None:
    """큐브맵 6면 이미지를 지정 디렉터리에 저장한다."""
    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)
    for face, name in zip(faces, FACE_NAMES):
        cv2.imwrite(str(out / f"{prefix}_{name}.png"), face)


def load_faces(
    input_dir: str,
    prefix: str = "face",
) -> List[np.ndarray]:
    """큐브맵 6면 이미지를 디렉터리에서 로드한다."""
    faces: List[np.ndarray] = []
    for name in FACE_NAMES:
        p = Path(input_dir) / f"{prefix}_{name}.png"
        img = cv2.imread(str(p), cv2.IMREAD_COLOR)
        if img is None:
            raise FileNotFoundError(f"면 이미지를 열 수 없습니다: {p}")
        faces.append(img)
    return faces
