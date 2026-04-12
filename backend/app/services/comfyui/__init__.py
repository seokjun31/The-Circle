"""
ComfyUI service layer for The Circle.

Provides:
  WorkflowManager    — builds ComfyUI API-format workflow dicts for each feature
  RunPodClient       — async client for RunPod Serverless endpoint
  LocalComfyUIClient — async client for a self-hosted ComfyUI instance
  get_comfyui_client — factory: returns the right client based on COMFYUI_PROVIDER
"""

from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.comfyui.runpod_client import RunPodClient
from app.services.comfyui.local_client import LocalComfyUIClient


def get_comfyui_client():
    """
    Return the appropriate ComfyUI client based on ``COMFYUI_PROVIDER`` env var.

    Values:
      ``runpod``  (default) — RunPodClient  → RunPod Serverless
      ``local``             — LocalComfyUIClient → self-hosted ComfyUI
    """
    from app.config import settings

    if settings.COMFYUI_PROVIDER == "local":
        return LocalComfyUIClient()
    return RunPodClient()


__all__ = [
    "WorkflowManager",
    "RunPodClient",
    "LocalComfyUIClient",
    "get_comfyui_client",
]
