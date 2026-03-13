"""
GET  /api/v1/materials              — 자재 목록 (category / style / page 필터)
GET  /api/v1/materials/{id}         — 자재 상세
POST /api/v1/materials              — 자재 등록 (관리자 전용)
"""
import math
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from app.dependencies import get_db, require_admin
from app.models.material import Material, MaterialCategory
from app.schemas.material import MaterialCreateRequest, MaterialListResponse, MaterialResponse

router = APIRouter(prefix="/materials", tags=["Materials"])

_PAGE_SIZE_DEFAULT = 20
_PAGE_SIZE_MAX = 100


@router.get(
    "",
    response_model=MaterialListResponse,
    summary="자재 목록 조회",
)
def list_materials(
    category: Optional[MaterialCategory] = None,
    style: Optional[str] = None,
    search: Optional[str] = None,
    page: int = 1,
    page_size: int = _PAGE_SIZE_DEFAULT,
    db: Session = Depends(get_db),
):
    """
    Query parameters:
      - category : wallpaper | flooring | ceiling | tile | paint
      - style    : exact string match (e.g. 'modern')
      - search   : partial name match
      - page     : 1-based page number
      - page_size: items per page (max 100)
    """
    page_size = min(page_size, _PAGE_SIZE_MAX)
    offset    = (page - 1) * page_size

    q = db.query(Material)

    if category:
        q = q.filter(Material.category == category)
    if style:
        q = q.filter(Material.style == style)
    if search:
        q = q.filter(Material.name.ilike(f"%{search}%"))

    total = q.count()
    items = q.order_by(Material.created_at.desc()).offset(offset).limit(page_size).all()

    return MaterialListResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=math.ceil(total / page_size) if total else 1,
    )


@router.get(
    "/{material_id}",
    response_model=MaterialResponse,
    summary="자재 상세 조회",
)
def get_material(material_id: int, db: Session = Depends(get_db)):
    material = db.get(Material, material_id)
    if material is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"message": "자재를 찾을 수 없습니다.", "code": "NOT_FOUND"},
        )
    return material


@router.post(
    "",
    response_model=MaterialResponse,
    status_code=status.HTTP_201_CREATED,
    summary="자재 등록 (관리자 전용)",
    dependencies=[Depends(require_admin)],
)
def create_material(body: MaterialCreateRequest, db: Session = Depends(get_db)):
    """Admin-only: register a new material in the catalog."""
    material = Material(**body.model_dump())
    db.add(material)
    db.commit()
    db.refresh(material)
    return material
