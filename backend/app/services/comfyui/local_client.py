"""
Local / Self-hosted ComfyUI async client for The Circle.

Image retrieval strategy (in priority order):
  1. WebSocket — connect before submitting so we receive real-time messages.
     Handles ETN_SendImageWebSocket (b64_images JSON) and binary preview frames.
  2. HTTP /view  — fallback for workflows that use a SaveImage node.
     Triggered when execution completes without a WebSocket image.

ComfyUI WebSocket messages handled:
  b64_images        — sent by ETN_SendImageWebSocket (comfyui-tooling-nodes)
  execution_error   — job failed; raises ComfyUIJobError
  execution_success — job done (ComfyUI ≥ 0.3); triggers HTTP fallback if no WS image
  executing(node=null) — job done (older ComfyUI); same as above
  binary frames     — low-quality preview JPEGs; kept as last-resort fallback

Supports any ComfyUI instance reachable over HTTP/WS:
  - Same machine:  http://localhost:8188
  - LAN PC:        http://192.168.1.100:8188
  - Tunnelled:     http://your-tunnel-url.trycloudflare.com

Authentication (optional):
  Set COMFYUI_LOCAL_API_KEY in .env to send an Authorization header.
"""

from __future__ import annotations

import asyncio
import base64
import json
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

POLL_INTERVAL: float = 2.0  # seconds between /history polls (HTTP fallback)
MAX_RETRIES: int = 3  # submit retries
_WS_RECV_TIMEOUT: float = 5.0  # per-message receive timeout inside WS loop


# ═══════════════════════════════════════════════════════════════════════════════
#  LocalComfyUIClient
# ═══════════════════════════════════════════════════════════════════════════════


class LocalComfyUIClient:
    """
    Async client for a self-hosted ComfyUI instance.

    Prefers WebSocket image delivery (ETN_SendImageWebSocket / PreviewImage),
    falls back to HTTP /view polling when a SaveImage node is used instead.

    Usage::

        client = LocalComfyUIClient()
        result = await client.run_async(workflow_dict, timeout=120)

    Result dict::

        {
            "image_base64": "<base64-encoded JPEG/PNG>",
            "result_url":   None,
            "prompt_id":    "<uuid>",
            "elapsed_s":    12.3,
        }
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
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
        upload_result: bool = True,
    ) -> dict[str, Any]:
        """Submit and wait (same interface as RunPodClient.run_sync)."""
        return await self.run_async(workflow, timeout=timeout)

    async def run_async(
        self,
        workflow: dict[str, Any],
        timeout: int = 120,
        upload_result: bool = True,
    ) -> dict[str, Any]:
        """
        Queue a workflow and wait for the output image.

        Connects to ComfyUI WebSocket first, then submits the workflow so no
        messages are missed.  If execution finishes without a WebSocket image
        (i.e. the workflow uses SaveImage), falls back to HTTP /view.

        Args:
            workflow:  ComfyUI API-format workflow dict.
            timeout:   Max seconds to wait for completion.

        Returns:
            ``{image_base64, result_url, prompt_id, elapsed_s}``

        Raises:
            ComfyUIError / ComfyUITimeoutError / ComfyUIJobError
        """
        t0 = time.monotonic()
        client_id = uuid.uuid4().hex
        deadline = t0 + timeout

        image_b64, prompt_id = await self._run_with_ws(workflow, client_id, deadline)

        elapsed = round(time.monotonic() - t0, 2)
        logger.info(
            "ComfyUI job done: prompt_id=%s elapsed=%.1fs b64_len=%d",
            prompt_id,
            elapsed,
            len(image_b64),
        )
        return {
            "image_base64": image_b64,
            "result_url": None,
            "prompt_id": prompt_id,
            "elapsed_s": elapsed,
        }

    # ── WebSocket pipeline ────────────────────────────────────────────────────

    async def _run_with_ws(
        self,
        workflow: dict[str, Any],
        client_id: str,
        deadline: float,
    ) -> tuple[str, str]:
        """
        Connect WebSocket → submit → receive image (WS or HTTP fallback).
        Returns (image_base64, prompt_id).
        """
        ws_url = (
            self._base_url.replace("http://", "ws://").replace("https://", "wss://")
            + f"/ws?clientId={client_id}"
        )
        # WS headers: drop Content-Type (not valid for WS handshake)
        ws_headers = {k: v for k, v in self._headers.items() if k != "Content-Type"}

        try:
            async with aiohttp.ClientSession() as session:
                async with session.ws_connect(
                    ws_url,
                    headers=ws_headers,
                    heartbeat=20,
                    timeout=aiohttp.ClientTimeout(
                        total=max(10.0, deadline - time.monotonic())
                    ),
                ) as ws:
                    prompt_id = await self._submit_with_session(
                        session, workflow, client_id
                    )
                    logger.info("ComfyUI job queued: prompt_id=%s", prompt_id)

                    ws_image = await self._recv_via_ws(ws, prompt_id, deadline)

                    if ws_image:
                        logger.info("Image received via WebSocket for %s", prompt_id)
                        return ws_image, prompt_id

                    # Execution complete but no WS image → SaveImage fallback
                    logger.info(
                        "No WS image for %s — falling back to HTTP /view", prompt_id
                    )
                    return await self._http_image(prompt_id, deadline), prompt_id

        except (ComfyUIError, ComfyUIJobError, ComfyUITimeoutError):
            raise
        except aiohttp.ClientConnectorError as exc:
            # WebSocket endpoint not reachable → pure HTTP fallback
            logger.warning("WebSocket unavailable (%s) — using HTTP-only pipeline", exc)
            return await self._run_http_only(workflow, client_id, deadline)

    async def _recv_via_ws(
        self,
        ws: aiohttp.ClientWebSocketResponse,
        prompt_id: str,
        deadline: float,
    ) -> Optional[str]:
        """
        Consume WebSocket messages until execution completes.

        Returns raw base64 image string if received via WebSocket,
        or None if execution completed without one (SaveImage case).

        WebSocket message types:
          b64_images        → image from ETN_SendImageWebSocket
          execution_error   → raises ComfyUIJobError
          execution_success → done (ComfyUI ≥ 0.3)
          executing(node=null) → done (older ComfyUI)
          binary            → JPEG preview frame (kept as fallback)
        """
        ws_images: list[str] = []
        last_binary_b64: Optional[str] = None

        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ComfyUITimeoutError(
                    f"ComfyUI job {prompt_id} timed out waiting for WebSocket"
                )

            try:
                msg = await asyncio.wait_for(
                    ws.receive(),
                    timeout=min(remaining, _WS_RECV_TIMEOUT),
                )
            except asyncio.TimeoutError:
                # Check whether the job is done via HTTP history
                remaining2 = deadline - time.monotonic()
                if remaining2 <= 0:
                    raise ComfyUITimeoutError(f"ComfyUI job {prompt_id} timed out")
                continue

            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                msg_type: str = data.get("type", "")
                msg_data: dict = data.get("data", {})

                if msg_type == "b64_images":
                    imgs = msg_data.get("images", [])
                    if imgs:
                        ws_images.extend(imgs)
                        logger.debug(
                            "b64_images received (%d img) for %s", len(imgs), prompt_id
                        )

                elif msg_type == "execution_error":
                    if msg_data.get("prompt_id") == prompt_id:
                        err = msg_data.get("exception_message") or str(msg_data)
                        raise ComfyUIJobError(f"ComfyUI job {prompt_id} failed: {err}")

                elif msg_type == "execution_success":
                    if msg_data.get("prompt_id") == prompt_id:
                        return ws_images[-1] if ws_images else last_binary_b64

                elif msg_type == "executing" and msg_data.get("node") is None:
                    # Older ComfyUI: null node = execution done
                    pid = msg_data.get("prompt_id")
                    if not pid or pid == prompt_id:
                        return ws_images[-1] if ws_images else last_binary_b64

            elif msg.type == aiohttp.WSMsgType.BINARY:
                # Binary preview frame: 8-byte header (type + format) + image bytes
                if len(msg.data) > 8:
                    last_binary_b64 = base64.b64encode(msg.data[8:]).decode()
                    logger.debug("Binary preview frame for %s", prompt_id)

            elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSED):
                logger.warning("WebSocket closed/error for %s", prompt_id)
                return ws_images[-1] if ws_images else last_binary_b64

    async def _http_image(self, prompt_id: str, deadline: float) -> str:
        """HTTP fallback: poll /history then download via /view (for SaveImage)."""
        remaining = int(max(10.0, deadline - time.monotonic()))
        history = await self._poll_until_done(prompt_id, remaining)
        filename, subfolder, file_type = self._extract_output_image(prompt_id, history)
        image_bytes = await self._download_image(filename, subfolder, file_type)
        return base64.b64encode(image_bytes).decode()

    async def _run_http_only(
        self,
        workflow: dict[str, Any],
        client_id: str,
        deadline: float,
    ) -> tuple[str, str]:
        """Pure HTTP pipeline (no WebSocket) used when WS is unavailable."""
        prompt_id = await self._submit(workflow, client_id)
        logger.info("ComfyUI job queued (HTTP-only): prompt_id=%s", prompt_id)
        image_b64 = await self._http_image(prompt_id, deadline)
        return image_b64, prompt_id

    # ── HTTP helpers ──────────────────────────────────────────────────────────

    async def _submit_with_session(
        self,
        session: aiohttp.ClientSession,
        workflow: dict[str, Any],
        client_id: str,
    ) -> str:
        """POST /prompt using an existing session; return prompt_id."""
        url = f"{self._base_url}/prompt"
        payload = {"prompt": workflow, "client_id": client_id}

        async with session.post(
            url,
            json=payload,
            headers=self._headers,
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

    async def _submit(self, workflow: dict[str, Any], client_id: str) -> str:
        """POST /prompt with retry (standalone, no shared session)."""
        last_exc: Optional[Exception] = None
        backoff = 2

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                async with aiohttp.ClientSession(headers=self._headers) as session:
                    return await self._submit_with_session(session, workflow, client_id)

            except (ComfyUIJobError, asyncio.TimeoutError) as exc:
                raise ComfyUIError(str(exc)) from exc

            except (aiohttp.ClientError, ComfyUIError) as exc:
                last_exc = exc
                if attempt < MAX_RETRIES:
                    logger.warning(
                        "ComfyUI submit failed (attempt %d/%d): %s — retry in %ds",
                        attempt,
                        MAX_RETRIES,
                        exc,
                        backoff,
                    )
                    await asyncio.sleep(backoff)
                    backoff *= 2

        raise ComfyUIError(
            f"ComfyUI submit failed after {MAX_RETRIES} attempts"
        ) from last_exc

    async def _poll_until_done(self, prompt_id: str, timeout: int) -> dict[str, Any]:
        """Poll /history/{id} until status is success or error."""
        deadline = time.monotonic() + timeout
        error_count = 0

        while time.monotonic() < deadline:
            try:
                data = await self._get_history(prompt_id)
                error_count = 0
            except Exception as exc:
                error_count += 1
                logger.warning(
                    "ComfyUI history poll error #%d for %s: %s",
                    error_count,
                    prompt_id,
                    exc,
                )
                if error_count >= 5:
                    raise ComfyUIError(
                        f"Too many consecutive poll errors for {prompt_id}"
                    ) from exc
                await asyncio.sleep(POLL_INTERVAL)
                continue

            entry = data.get(prompt_id)
            if not entry:
                await asyncio.sleep(POLL_INTERVAL)
                continue

            status_str: str = entry.get("status", {}).get("status_str", "")
            logger.debug("prompt_id=%s status=%s", prompt_id, status_str)

            if status_str == "success":
                return entry
            if status_str == "error":
                messages = entry.get("status", {}).get("messages", [])
                raise ComfyUIJobError(f"ComfyUI job {prompt_id} failed: {messages}")

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
        Find the first file-based output image in the history (for SaveImage node).

        Skips WebSocket-only entries (no ``filename`` key) such as those produced
        by PreviewImage or ETN_SendImageWebSocket.

        Returns (filename, subfolder, type).
        """
        outputs: dict = history.get("outputs", {})
        for node_id, node_output in outputs.items():
            for img in node_output.get("images", []):
                filename = img.get("filename")
                if filename:
                    return filename, img.get("subfolder", ""), img.get("type", "output")
                logger.debug(
                    "Skipping WebSocket-only output on node '%s' (keys=%s)",
                    node_id,
                    list(img.keys()),
                )

        raise ComfyUIJobError(
            f"ComfyUI job {prompt_id}: no file-based output image found. "
            f"Output nodes: {list(outputs.keys())}. "
            "워크플로우에 SaveImage 노드를 추가하거나 "
            "ETN_SendImageWebSocket 노드가 동작하는지 확인하세요."
        )

    async def _download_image(
        self, filename: str, subfolder: str, file_type: str
    ) -> bytes:
        """GET /view?filename=...&subfolder=...&type=..."""
        url = f"{self._base_url}/view"
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
