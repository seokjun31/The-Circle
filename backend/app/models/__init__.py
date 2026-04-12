"""
Import all models here so that:
 - SQLAlchemy metadata is fully populated (needed for Alembic autogenerate)
 - Application code can do:  from app.models import User, Project, ...
"""

from app.models.user import User
from app.models.project import Project, ImageType, ProjectStatus
from app.models.edit_layer import EditLayer, LayerType
from app.models.material import Material, MaterialCategory
from app.models.furniture import Furniture, FurnitureCategory
from app.models.credit_transaction import CreditTransaction, CreditType

__all__ = [
    "User",
    "Project",
    "ImageType",
    "ProjectStatus",
    "EditLayer",
    "LayerType",
    "Material",
    "MaterialCategory",
    "Furniture",
    "FurnitureCategory",
    "CreditTransaction",
    "CreditType",
]
