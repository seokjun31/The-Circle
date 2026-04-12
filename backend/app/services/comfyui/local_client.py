"""
Local / Self-hosted ComfyUI async client for The Circle.

Targets the native ComfyUI HTTP API (default port 8188):
  POST /prompt          — queue a workflow
  GET  /history/{id}    — poll until complete
  GET  /view            — download the output image

Supports any ComfyUI instance reachable over HTTP:
  - Same machine:  http://localhost:8188
  - LAN PC:        http://192.168.1.100:8188
  - Tunnelled:     http://your-tunnel-url.trycloudflare.com

Interface is identical to RunPodClient so services need no changes.

Authentication (optional):
  Set COMFYUI_LOCAL_API_KEY in .env to send an Authorization header.
  Most self-hosted ComfyUI setups run without auth.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
import uuid
from typing import Any, Optional

import aiohttp

from app.config import settings

# Re-export RunPod exceptions so services that already import them keep working
from app.services.comfyui.runpod_client import (
    RunPodError as ComfyUIError,
    RunPodJobError as ComfyUIJobError,
    RunPodTimeoutError as ComfyUITimeoutError,
)

logger = logging.getLogger("the_circle.local_comfyui")

# ── Constants ─────────────────────────────────────────────────────────────────

POLL_INTERVAL: float = 2.0  # seconds between /history polls
MAX_RETRIES: int = 3
_TERMINAL_STATUSES = {"success", "error"}


# ═══════════════════════════════════════════════════════════════════════════════
#  LocalComfyUIClient
# ═══════════════════════════════════════════════════════════════════════════════

class LocalComfyUIClient:
    """
    Async client for a self-hosted ComfyUI instance.

    Usage::

        client = LocalComfyUIClient()

        # Both methods share the same interface as RunPodClient
        result = await client.run_async(workflow_dict, timeout=120)
        result = await client.run_sync(workflow_dict, timeout=120)

    Result dict::

        {
            "image_base64": "<base64-encoded JPEG/PNG>",
            "result_url":   None,          # local client never produces an S3 URL
            "prompt_id":    "<uuid>",
            "elapsed_s":    12.3,
        }
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key:  Optional[str] = None,
    ) -> None:
        self._base_url = (base_url or settings.COMFYUI_LOCAL_URL).rstrip("/")
        raw_key = api_key or settings.COMFYUI_LOCAL_API_KEY
        self._headers: dict[str, str] = {"Content-Type": "application/json"}
        if raw_key:
            self._headers["Authorization"] = f"Bearer {raw_key}"

    # ── Public API ────────────────────────────────────────────────────────────

    async def run_sync(
        self,
        workflow: dict[str, Any],
        timeout: int = 120,
        upload_result: bool = True,   # accepted for API compat, ignored locally
    ) -> dict[str, Any]:
        """Submit and wait (same interface as RunPodClient.run_sync)."""
        return await self.run_async(workflow, timeout=timeout)

    async def run_async(
        self,
        workflow: dict[str, Any],
        timeout: int = 120,
        upload_result: bool = True,   # accepted for API compat, ignored locally
    ) -> dict[str, Any]:
        """
        Queue a workflow and poll until done.

        Args:
            workflow:  ComfyUI API-format workflow dict (same JSON that
                       WorkflowManager produces — no wrapping needed).
            timeout:   Max seconds to wait.

        Returns:
            ``{image_base64, result_url, prompt_id, elapsed_s}``

        Raises:
            ComfyUIError / ComfyUITimeoutError / ComfyUIJobError
        """
        t0 = time.monotonic()
        client_id = uuid.uuid4().hex

        # 1. Submit
        prompt_id = await self._submit(workflow, client_id)
        logger.info("ComfyUI job queued: prompt_id=%s", prompt_id)

        # 2. Poll history until done
        history = await self._poll_until_done(prompt_id, timeout)

        # 3. Extract first output image filename
        filename, subfolder, file_type = self._extract_output_image(prompt_id, history)

        # 4. Download image bytes
        image_bytes = await self._download_image(filename, subfolder, file_type)

        # 5. Convert to base64
        image_b64 = base64.b64encode(image_bytes).decode()

        elapsed = round(time.monotonic() - t0, 2)
        logger.info(
            "ComfyUI job done: prompt_id=%s elapsed=%.1fs size=%d bytes",
            prompt_id, elapsed, len(image_bytes),
        )

        return {
            "image_base64": image_b64,
            "result_url":   None,
            "prompt_id":    prompt_id,
            "elapsed_s":    elapsed,
        }

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _submit(self, workflow: dict[str, Any], client_id: str) -> str:
        """POST /prompt and return prompt_id."""
        url     = f"{self._base_url}/prompt"
        payload = {"prompt": workflow, "client_id": client_id}

        last_exc: Optional[Exception] = None
        backoff = 2

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                async with aiohttp.ClientSession(headers=self._headers) as session:
                    async with session.post(
                        url,
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=30),
                    ) as resp:
                        if resp.status >= 500:
                            body = await resp.text()
                            raise ComfyUIError(f"ComfyUI HTTP {resp.status}: {body[:200]}")
                        if resp.status == 400:
                            body = await resp.json()
                            raise ComfyUIJobError(
                                f"ComfyUI rejected workflow: {body.get('error', body)}"
                            )
                        resp.raise_for_status()
                        data = await resp.json()

                prompt_id = data.get("prompt_id")
                if not prompt_id:
                    raise ComfyUIError(f"ComfyUI did not return prompt_id: {data}")
                return prompt_id

            except (ComfyUIJobError, asyncio.TimeoutError) as exc:
                raise ComfyUIError(str(exc)) from exc

            except (aiohttp.ClientError, ComfyUIError) as exc:
                last_exc = exc
                if attempt < MAX_RETRIES:
                    logger.warning(
                        "ComfyUI submit failed (attempt %d/%d): %s — retry in %ds",
                        attempt, MAX_RETRIES, exc, backoff,
                    )
                    await asyncio.sleep(backoff)
                    backoff *= 2

        raise ComfyUIError(
            f"ComfyUI submit failed after {MAX_RETRIES} attempts"
        ) from last_exc

    async def _poll_until_done(
        self, prompt_id: str, timeout: int
    ) -> dict[str, Any]:
        """
        Poll GET /history/{prompt_id} until status_str is 'success' or 'error'.

        ComfyUI /history returns an empty dict {} while the job is still running.
        Once finished the key equals prompt_id.

        Returns the full history entry dict on success.
        """
        deadline    = time.monotonic() + timeout
        error_count = 0

        while time.monotonic() < deadline:
            try:
                data = await self._get_history(prompt_id)
                error_count = 0
            except Exception as exc:
                error_count += 1
                logger.warning(
                    "ComfyUI history poll error #%d for %s: %s",
                    error_count, prompt_id, exc,
                )
                if error_count >= 5:
                    raise ComfyUIError(
                        f"Too many consecutive poll errors for {prompt_id}"
                    ) from exc
                await asyncio.sleep(POLL_INTERVAL)
                continue

            entry = data.get(prompt_id)
            if not entry:
                # Job still in queue or running
                await asyncio.sleep(POLL_INTERVAL)
                continue

            status_str: str = entry.get("status", {}).get("status_str", "")
            logger.debug("prompt_id=%s status=%s", prompt_id, status_str)

            if status_str == "success":
                return entry
            if status_str == "error":
                messages = entry.get("status", {}).get("messages", [])
                raise ComfyUIJobError(
                    f"ComfyUI job {prompt_id} failed: {messages}"
                )

            # unknown / empty status_str — keep polling
            await asyncio.sleep(POLL_INTERVAL)

        raise ComfyUITimeoutError(
            f"ComfyUI job {prompt_id} did not complete within {timeout}s"
        )

    async def _get_history(self, prompt_id: str) -> dict[str, Any]:
        """GET /history/{prompt_id}."""
        url = f"{self._base_url}/history/{prompt_id}"
        async with aiohttp.ClientSession(headers=self._headers) as session:
            async with session.get(
                url, timeout=aiohttp.ClientTimeout(total=15)
            ) as resp:
                resp.raise_for_status()
                return await resp.json()

    @staticmethod
    def _extract_output_image(
        prompt_id: str, history: dict[str, Any]
    ) -> tuple[str, str, str]:
        """
        Find the first output image in the history entry.

        ComfyUI output structure::

            {
              "outputs": {
                "node_id": {
                  "images": [
                    {"filename": "ComfyUI_00001_.png", "subfolder": "", "type": "output"}
                  ]
                }
              }
            }

        Returns (filename, subfolder, type).
        """
        outputs: dict = history.get("outputs", {})
        for node_id, node_output in outputs.items():
            images = node_output.get("images", [])
            for img in images:
                filename = img.get("filename")
                if filename:
                    # Valid file-based output (SaveImage / PreviewImage with saved temp file)
                    return filename, img.get("subfolder", ""), img.get("type", "output")
                # No filename → WebSocket-only output (PreviewImage / ETN_SendImageWebSocket)
                # Skip and keep looking for a SaveImage node that wrote a real file.
                logger.debug(
                    "Skipping node '%s' output with no filename (source=%r, keys=%s)",
                    node_id, img.get("source"), list(img.keys()),
                )

        raise ComfyUIJobError(
            f"ComfyUI job {prompt_id} produced no saved output images. "
            f"Output nodes: {list(outputs.keys())}. "
            "워크플로우에 SaveImage 노드가 있는지 확인하세요."
        )

    async def _download_image(
        self, filename: str, subfolder: str, file_type: str
    ) -> bytes:
        """GET /view?filename=...&subfolder=...&type=... → raw bytes."""
        url    = f"{self._base_url}/view"
        params = {"filename": filename, "subfolder": subfolder, "type": file_type}

        async with aiohttp.ClientSession(headers=self._headers) as session:
            async with session.get(
                url,
                params=params,
                timeout=aiohttp.ClientTimeout(total=60),
            ) as resp:
                if resp.status == 404:
                    raise ComfyUIJobError(
                        f"ComfyUI image not found: {filename} (subfolder={subfolder!r})"
                    )
                resp.raise_for_status()
                return await resp.read()
