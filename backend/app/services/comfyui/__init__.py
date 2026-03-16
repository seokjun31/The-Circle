"""
ComfyUI service layer for The Circle.

Provides:
  WorkflowManager  — builds ComfyUI API-format workflow dicts for each feature
  RunPodClient     — async client for RunPod Serverless endpoint
"""
from app.services.comfyui.workflow_manager import WorkflowManager
from app.services.comfyui.runpod_client import RunPodClient

__all__ = ["WorkflowManager", "RunPodClient"]
