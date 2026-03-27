"""
자재 시드 데이터 스크립트
─────────────────────────────────────────────────────────────
실행 방법 (Docker 환경):
  docker-compose exec backend python seed_materials.py

로컬 직접 실행:
  cd backend
  python seed_materials.py

동작:
  1. uploads/materials/ 폴더 생성
  2. 카테고리별 샘플 PNG 이미지 생성 (Pillow로 색상 패턴 제작)
  3. materials 테이블에 샘플 자재 데이터 INSERT
     (이미 같은 이름이 있으면 스킵)
"""

import os
import sys
from pathlib import Path

# ── 프로젝트 루트를 sys.path에 추가 ───────────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))

from PIL import Image, ImageDraw, ImageFilter
import numpy as np

from app.database import SessionLocal
from app.models.material import Material, MaterialCategory

# ── 저장 경로 ─────────────────────────────────────────────────────────────────
UPLOAD_DIR = Path("./uploads/materials")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# URL prefix (FastAPI가 /uploads 로 서빙)
URL_PREFIX = "/uploads/materials"


# ─────────────────────────────────────────────────────────────────────────────
#  이미지 생성 유틸
# ─────────────────────────────────────────────────────────────────────────────

def make_solid(color: tuple, size=512) -> Image.Image:
    """단색 이미지"""
    img = Image.new("RGB", (size, size), color)
    return img


def make_noise(base_color: tuple, noise_amount=30, size=512) -> Image.Image:
    """노이즈가 섞인 텍스처 (콘크리트, 페인트 등)"""
    arr = np.full((size, size, 3), base_color, dtype=np.uint8)
    noise = np.random.randint(-noise_amount, noise_amount, (size, size, 3))
    arr = np.clip(arr.astype(int) + noise, 0, 255).astype(np.uint8)
    return Image.fromarray(arr)


def make_wood(base_color: tuple, size=512) -> Image.Image:
    """나무결 패턴"""
    img = Image.new("RGB", (size, size), base_color)
    draw = ImageDraw.Draw(img)
    r, g, b = base_color
    for y in range(0, size, 12):
        offset = int(10 * np.sin(y * 0.15))
        shade = np.random.randint(-20, 20)
        line_color = (
            max(0, min(255, r + shade)),
            max(0, min(255, g + shade)),
            max(0, min(255, b + shade)),
        )
        draw.line([(0, y + offset), (size, y + offset + 3)], fill=line_color, width=2)
    return img.filter(ImageFilter.GaussianBlur(radius=0.8))


def make_tile_grid(color1: tuple, color2: tuple, tile_px=64, size=512) -> Image.Image:
    """타일 그리드 패턴"""
    img = Image.new("RGB", (size, size), color1)
    draw = ImageDraw.Draw(img)
    for x in range(0, size, tile_px):
        draw.line([(x, 0), (x, size)], fill=color2, width=2)
    for y in range(0, size, tile_px):
        draw.line([(0, y), (size, y)], fill=color2, width=2)
    return img


def make_marble(base_color: tuple, vein_color: tuple, size=512) -> Image.Image:
    """대리석 패턴"""
    arr = np.full((size, size, 3), base_color, dtype=np.uint8)
    noise = np.random.randn(size, size) * 30
    for _ in range(8):
        x0 = np.random.randint(0, size)
        x1 = np.random.randint(0, size)
        for y in range(size):
            x = int(x0 + (x1 - x0) * y / size + noise[y, min(x0, size - 1)])
            x = max(0, min(size - 1, x))
            for dx in range(-2, 3):
                xx = max(0, min(size - 1, x + dx))
                alpha = max(0.0, 1.0 - abs(dx) / 3.0)
                for c in range(3):
                    arr[y, xx, c] = int(
                        arr[y, xx, c] * (1 - alpha) + vein_color[c] * alpha
                    )
    return Image.fromarray(arr.astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.5))


def make_brick(color1: tuple, color2: tuple, size=512) -> Image.Image:
    """벽돌 패턴"""
    img = Image.new("RGB", (size, size), color1)
    draw = ImageDraw.Draw(img)
    bh, bw = 40, 80
    for row, y in enumerate(range(0, size, bh)):
        offset = (bw // 2) if row % 2 else 0
        for x in range(-offset, size, bw):
            draw.rectangle([x + 2, y + 2, x + bw - 2, y + bh - 2], outline=color2, width=3)
    return img


def save_image(img: Image.Image, filename: str) -> str:
    path = UPLOAD_DIR / filename
    img.save(str(path), "PNG")
    return f"{URL_PREFIX}/{filename}"


# ─────────────────────────────────────────────────────────────────────────────
#  시드 데이터 정의
# ─────────────────────────────────────────────────────────────────────────────

SEED_MATERIALS = [
    # ── WALLPAPER ────────────────────────────────────────────────────────────
    {
        "name": "화이트 페인트 벽지",
        "category": MaterialCategory.wallpaper,
        "style": "modern",
        "tile_width_cm": 100, "tile_height_cm": 100,
        "positive_prompt": "seamless white paint wall, clean matte finish, modern interior wall, photorealistic",
        "negative_prompt": "dirty, cracks, wallpaper pattern, texture, glossy",
        "ip_adapter_weight": 0.45,
        "recommended_denoise": 0.55,
        "tags": ["white", "modern", "clean"],
        "image_fn": "wp_white_paint.png",
        "image": lambda: make_noise((240, 240, 238), 8),
    },
    {
        "name": "베이지 린넨 벽지",
        "category": MaterialCategory.wallpaper,
        "style": "natural",
        "tile_width_cm": 53, "tile_height_cm": 100,
        "positive_prompt": "seamless beige linen texture wallpaper, fabric weave pattern, warm neutral tone, photorealistic",
        "negative_prompt": "shiny, wet, concrete, stone, modern",
        "ip_adapter_weight": 0.6,
        "recommended_denoise": 0.60,
        "tags": ["beige", "linen", "natural", "warm"],
        "image_fn": "wp_beige_linen.png",
        "image": lambda: make_noise((210, 195, 175), 18),
    },
    {
        "name": "다크 그레이 벽지",
        "category": MaterialCategory.wallpaper,
        "style": "modern",
        "tile_width_cm": 53, "tile_height_cm": 100,
        "positive_prompt": "seamless dark charcoal gray wall paint, matte finish, sophisticated interior, photorealistic",
        "negative_prompt": "bright, white, pattern, texture, glossy",
        "ip_adapter_weight": 0.5,
        "recommended_denoise": 0.65,
        "tags": ["dark", "gray", "modern", "bold"],
        "image_fn": "wp_dark_gray.png",
        "image": lambda: make_noise((55, 55, 60), 12),
    },
    {
        "name": "우드 패널 벽지",
        "category": MaterialCategory.wallpaper,
        "style": "nordic",
        "tile_width_cm": 120, "tile_height_cm": 240,
        "positive_prompt": "seamless light oak wood panel wall, horizontal planks, scandinavian interior, photorealistic",
        "negative_prompt": "dark, knots, rough, painted, wallpaper",
        "ip_adapter_weight": 0.65,
        "recommended_denoise": 0.62,
        "tags": ["wood", "panel", "nordic", "oak"],
        "image_fn": "wp_wood_panel.png",
        "image": lambda: make_wood((185, 155, 115)),
    },

    # ── FLOORING ─────────────────────────────────────────────────────────────
    {
        "name": "오크 원목 마루",
        "category": MaterialCategory.flooring,
        "style": "natural",
        "tile_width_cm": 12, "tile_height_cm": 120,
        "positive_prompt": "seamless oak hardwood floor, natural wood grain, warm honey tone, photorealistic interior floor",
        "negative_prompt": "carpet, tile, concrete, painted, glossy lacquer",
        "ip_adapter_weight": 0.62,
        "recommended_denoise": 0.60,
        "tags": ["oak", "wood", "warm", "natural"],
        "image_fn": "fl_oak_wood.png",
        "image": lambda: make_wood((185, 145, 90)),
    },
    {
        "name": "다크 월넛 마루",
        "category": MaterialCategory.flooring,
        "style": "classic",
        "tile_width_cm": 12, "tile_height_cm": 120,
        "positive_prompt": "seamless dark walnut hardwood floor, rich brown grain, luxury interior floor, photorealistic",
        "negative_prompt": "light, blonde, carpet, tile, painted",
        "ip_adapter_weight": 0.65,
        "recommended_denoise": 0.63,
        "tags": ["walnut", "dark", "luxury", "classic"],
        "image_fn": "fl_dark_walnut.png",
        "image": lambda: make_wood((75, 45, 25)),
    },
    {
        "name": "화이트 오크 마루",
        "category": MaterialCategory.flooring,
        "style": "nordic",
        "tile_width_cm": 12, "tile_height_cm": 120,
        "positive_prompt": "seamless white oak hardwood floor, light ash tone, scandinavian minimal interior, photorealistic",
        "negative_prompt": "dark, knots, carpet, tile, warm orange",
        "ip_adapter_weight": 0.58,
        "recommended_denoise": 0.58,
        "tags": ["white oak", "light", "nordic", "minimal"],
        "image_fn": "fl_white_oak.png",
        "image": lambda: make_wood((215, 200, 175)),
    },
    {
        "name": "헤링본 원목 마루",
        "category": MaterialCategory.flooring,
        "style": "classic",
        "tile_width_cm": 8, "tile_height_cm": 40,
        "positive_prompt": "seamless herringbone oak parquet floor, classic pattern, warm interior, photorealistic",
        "negative_prompt": "carpet, tile, concrete, modern plain",
        "ip_adapter_weight": 0.70,
        "recommended_denoise": 0.62,
        "tags": ["herringbone", "parquet", "classic", "pattern"],
        "image_fn": "fl_herringbone.png",
        "image": lambda: make_wood((165, 125, 80)),
    },

    # ── TILE ─────────────────────────────────────────────────────────────────
    {
        "name": "화이트 대형 포세린 타일",
        "category": MaterialCategory.tile,
        "style": "modern",
        "tile_width_cm": 60, "tile_height_cm": 60,
        "positive_prompt": "seamless large format white porcelain tile floor, subtle texture, clean grout lines, modern interior, photorealistic",
        "negative_prompt": "wood grain, carpet, colored, pattern, glossy wet",
        "ip_adapter_weight": 0.50,
        "recommended_denoise": 0.57,
        "tags": ["white", "porcelain", "large", "modern", "clean"],
        "image_fn": "tl_white_porcelain.png",
        "image": lambda: make_tile_grid((238, 236, 232), (200, 198, 195), tile_px=128),
    },
    {
        "name": "그레이 콘크리트 타일",
        "category": MaterialCategory.tile,
        "style": "modern",
        "tile_width_cm": 60, "tile_height_cm": 60,
        "positive_prompt": "seamless gray concrete look porcelain tile, industrial modern floor, subtle texture, photorealistic",
        "negative_prompt": "wood, carpet, glossy, colored pattern",
        "ip_adapter_weight": 0.55,
        "recommended_denoise": 0.60,
        "tags": ["gray", "concrete", "industrial", "modern"],
        "image_fn": "tl_gray_concrete.png",
        "image": lambda: make_noise((160, 158, 155), 20),
    },
    {
        "name": "화이트 마블 타일",
        "category": MaterialCategory.tile,
        "style": "classic",
        "tile_width_cm": 60, "tile_height_cm": 60,
        "positive_prompt": "seamless white Carrara marble tile, elegant gray veins, luxury interior floor, photorealistic",
        "negative_prompt": "wood grain, carpet, colored, concrete, matte",
        "ip_adapter_weight": 0.65,
        "recommended_denoise": 0.62,
        "tags": ["marble", "white", "luxury", "classic", "veins"],
        "image_fn": "tl_white_marble.png",
        "image": lambda: make_marble((238, 235, 230), (140, 135, 130)),
    },
    {
        "name": "블랙 마블 타일",
        "category": MaterialCategory.tile,
        "style": "modern",
        "tile_width_cm": 60, "tile_height_cm": 60,
        "positive_prompt": "seamless black marble tile with gold veins, luxury dark interior floor, photorealistic",
        "negative_prompt": "white, light, carpet, wood, matte concrete",
        "ip_adapter_weight": 0.70,
        "recommended_denoise": 0.65,
        "tags": ["black", "marble", "gold", "luxury", "bold"],
        "image_fn": "tl_black_marble.png",
        "image": lambda: make_marble((25, 22, 20), (180, 155, 80)),
    },
    {
        "name": "테라코타 타일",
        "category": MaterialCategory.tile,
        "style": "natural",
        "tile_width_cm": 30, "tile_height_cm": 30,
        "positive_prompt": "seamless terracotta floor tile, warm earthy orange-red tone, Mediterranean interior, photorealistic",
        "negative_prompt": "cold, gray, modern, glossy, marble",
        "ip_adapter_weight": 0.60,
        "recommended_denoise": 0.60,
        "tags": ["terracotta", "warm", "earthy", "mediterranean"],
        "image_fn": "tl_terracotta.png",
        "image": lambda: make_noise((190, 110, 75), 22),
    },
    {
        "name": "헥사곤 모자이크 타일",
        "category": MaterialCategory.tile,
        "style": "modern",
        "tile_width_cm": 5, "tile_height_cm": 5,
        "positive_prompt": "seamless white hexagon mosaic tile, bathroom wall tile, geometric pattern, photorealistic",
        "negative_prompt": "floor, carpet, wood, concrete, plain",
        "ip_adapter_weight": 0.70,
        "recommended_denoise": 0.62,
        "tags": ["hexagon", "mosaic", "bathroom", "geometric"],
        "image_fn": "tl_hexagon.png",
        "image": lambda: make_tile_grid((245, 243, 240), (210, 208, 205), tile_px=32),
    },

    # ── PAINT ─────────────────────────────────────────────────────────────────
    {
        "name": "오프화이트 페인트",
        "category": MaterialCategory.paint,
        "style": "modern",
        "tile_width_cm": 100, "tile_height_cm": 100,
        "positive_prompt": "seamless off-white matte wall paint, warm white tone, clean modern interior wall, photorealistic",
        "negative_prompt": "pattern, texture, dark, colorful, shiny",
        "ip_adapter_weight": 0.42,
        "recommended_denoise": 0.53,
        "tags": ["white", "off-white", "warm", "clean", "minimal"],
        "image_fn": "pt_off_white.png",
        "image": lambda: make_noise((245, 240, 230), 6),
    },
    {
        "name": "세이지 그린 페인트",
        "category": MaterialCategory.paint,
        "style": "natural",
        "tile_width_cm": 100, "tile_height_cm": 100,
        "positive_prompt": "seamless sage green matte wall paint, calming green-gray tone, biophilic interior, photorealistic",
        "negative_prompt": "pattern, bright green, neon, shiny, texture",
        "ip_adapter_weight": 0.48,
        "recommended_denoise": 0.58,
        "tags": ["green", "sage", "natural", "calming"],
        "image_fn": "pt_sage_green.png",
        "image": lambda: make_noise((150, 170, 148), 10),
    },
    {
        "name": "네이비 블루 페인트",
        "category": MaterialCategory.paint,
        "style": "classic",
        "tile_width_cm": 100, "tile_height_cm": 100,
        "positive_prompt": "seamless navy blue matte wall paint, deep blue tone, sophisticated interior accent wall, photorealistic",
        "negative_prompt": "pattern, bright, neon, shiny, texture, light",
        "ip_adapter_weight": 0.52,
        "recommended_denoise": 0.65,
        "tags": ["navy", "blue", "bold", "accent"],
        "image_fn": "pt_navy.png",
        "image": lambda: make_noise((30, 45, 90), 10),
    },
    {
        "name": "테라코타 페인트",
        "category": MaterialCategory.paint,
        "style": "natural",
        "tile_width_cm": 100, "tile_height_cm": 100,
        "positive_prompt": "seamless terracotta orange matte wall paint, warm earthy tone, boho interior accent wall, photorealistic",
        "negative_prompt": "pattern, cold, blue, shiny, texture",
        "ip_adapter_weight": 0.50,
        "recommended_denoise": 0.60,
        "tags": ["terracotta", "orange", "warm", "boho"],
        "image_fn": "pt_terracotta.png",
        "image": lambda: make_noise((195, 108, 70), 12),
    },
    {
        "name": "머스타드 옐로우 페인트",
        "category": MaterialCategory.paint,
        "style": "classic",
        "tile_width_cm": 100, "tile_height_cm": 100,
        "positive_prompt": "seamless mustard yellow matte wall paint, warm golden tone, mid-century modern interior, photorealistic",
        "negative_prompt": "pattern, bright neon, shiny, texture",
        "ip_adapter_weight": 0.50,
        "recommended_denoise": 0.60,
        "tags": ["yellow", "mustard", "warm", "mid-century"],
        "image_fn": "pt_mustard.png",
        "image": lambda: make_noise((205, 170, 50), 12),
    },

    # ── WALLPAPER (additional) ────────────────────────────────────────────────
    {
        "name": "벽돌 노출 벽지",
        "category": MaterialCategory.wallpaper,
        "style": "classic",
        "tile_width_cm": 60, "tile_height_cm": 60,
        "positive_prompt": "seamless exposed red brick wall, industrial interior accent wall, photorealistic",
        "negative_prompt": "painted, smooth, modern, clean, white",
        "ip_adapter_weight": 0.72,
        "recommended_denoise": 0.65,
        "tags": ["brick", "exposed", "industrial", "red"],
        "image_fn": "wp_brick.png",
        "image": lambda: make_brick((175, 95, 65), (210, 185, 170)),
    },
]


# ─────────────────────────────────────────────────────────────────────────────
#  실행
# ─────────────────────────────────────────────────────────────────────────────

def run():
    db = SessionLocal()
    inserted = 0
    skipped  = 0

    print(f"\n{'─'*60}")
    print("  The Circle — 자재 시드 데이터 등록")
    print(f"{'─'*60}\n")

    try:
        for m in SEED_MATERIALS:
            # 중복 체크
            exists = db.query(Material).filter(Material.name == m["name"]).first()
            if exists:
                print(f"  [SKIP]  {m['name']}")
                skipped += 1
                continue

            # 이미지 생성 & 저장
            img = m["image"]()
            url = save_image(img, m["image_fn"])
            print(f"  [IMG]   {m['image_fn']}  →  {url}")

            # DB 레코드 생성
            record = Material(
                name               = m["name"],
                category           = m["category"],
                tile_image_url     = url,
                tile_width_cm      = m.get("tile_width_cm"),
                tile_height_cm     = m.get("tile_height_cm"),
                style              = m.get("style"),
                tags               = m.get("tags", []),
                positive_prompt    = m.get("positive_prompt", ""),
                negative_prompt    = m.get("negative_prompt", ""),
                ip_adapter_weight  = m.get("ip_adapter_weight", 0.6),
                recommended_denoise= m.get("recommended_denoise", 0.62),
            )
            db.add(record)
            db.commit()
            db.refresh(record)
            print(f"  [DB]    id={record.id}  {record.name}  [{record.category.value}]")
            inserted += 1

    except Exception as e:
        db.rollback()
        print(f"\n  [ERROR] {e}")
        raise
    finally:
        db.close()

    print(f"\n{'─'*60}")
    print(f"  완료: {inserted}개 등록 / {skipped}개 스킵")
    print(f"  이미지 폴더: {UPLOAD_DIR.resolve()}")
    print(f"{'─'*60}\n")


if __name__ == "__main__":
    run()
