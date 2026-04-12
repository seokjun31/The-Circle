"""
RunPod Serverless async client for The Circle.

Supports two invocation modes:
  - run_sync  : POST /runsync  — waits inline (best for short jobs ≤30s, limited by RunPod)
  - run_async : POST /run      — queues job, polls /status/{id} until done

Retry logic:
  - Up to MAX_RETRIES=3 attempts on network / 5xx errors
  - Exponential backoff: 2s, 4s, 8s between retries

Timeouts:
  - Default jobs: RUNPOD_TIMEOUT_DEFAULT (120 s)
  - Final render jobs: RUNPOD_TIMEOUT_FINAL_RENDER (300 s)

Scale-to-Zero (MVP):
  - RUNPOD_MIN_WORKERS=0 keeps cost at $0 when idle
  - Cold-start ≈ 30-60 s; upgrade to 1 warm worker once >50 paid users

Local dev mock:
  - Set USE_MOCK_AI=true in .env to skip RunPod entirely.
  - run_async / run_sync return a placeholder gradient image immediately.
  - The original image from the workflow (first ETN_LoadImageBase64 node) is
    returned with a coloured overlay so you can tell it went through the mock.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import os
import time
from typing import Any, Optional

import aiohttp

from app.config import settings

logger = logging.getLogger("the_circle.runpod_client")

# ── Constants ─────────────────────────────────────────────────────────────────

MAX_RETRIES: int = 3
POLL_INTERVAL: float = 3.0  # seconds between /status polls
_BASE_URL_TMPL = "https://api.runpod.io/v2/{endpoint_id}"


# ═══════════════════════════════════════════════════════════════════════════════
#  Exceptions
# ═══════════════════════════════════════════════════════════════════════════════


class RunPodError(Exception):
    """Base exception for RunPod client errors."""


class RunPodTimeoutError(RunPodError):
    """Job did not complete within the allowed time."""


class RunPodJobError(RunPodError):
    """RunPod reported the job as FAILED."""


# ═══════════════════════════════════════════════════════════════════════════════
#  Local mock (USE_MOCK_AI=true)
# ═══════════════════════════════════════════════════════════════════════════════


def _is_mock_mode() -> bool:
    from app.config import settings

    return settings.USE_MOCK_AI or os.environ.get("USE_MOCK_AI", "").lower() in (
        "1",
        "true",
        "yes",
    )


def _make_mock_image(width: int = 800, height: int = 600) -> str:
    """
    Return a base64-encoded JPEG placeholder image.

    Uses only stdlib + Pillow (already in requirements).
    The image is a purple-to-blue gradient with a centred "AI MOCK" label.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont

        img = Image.new("RGB", (width, height))
        draw = ImageDraw.Draw(img)

        # Gradient background: purple → dark blue
        for y in range(height):
            r = int(80 + (y / height) * 20)
            g = int(20 + (y / height) * 30)
            b = int(140 + (y / height) * 60)
            draw.line([(0, y), (width, y)], fill=(r, g, b))

        # Centred label
        text = "[ AI MOCK — RunPod 미연결 ]"
        try:
            font = ImageFont.truetype(
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28
            )
        except Exception:
            font = ImageFont.load_default()

        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        draw.rectangle(
            [
                width // 2 - tw // 2 - 16,
                height // 2 - th // 2 - 12,
                width // 2 + tw // 2 + 16,
                height // 2 + th // 2 + 12,
            ],
            fill=(0, 0, 0, 180),
        )
        draw.text(
            (width // 2 - tw // 2, height // 2 - th // 2),
            text,
            font=font,
            fill=(255, 255, 255),
        )

        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode()

    except Exception:
        # Fallback: 1×1 red pixel
        return (
            "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkS"
            "Ew8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC"
            "AABAAEDASIA2gABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB"
            "/8QAIRAAAQMEAgMAAAAAAAAAAAAAAQIDBAUREiExQVH/xAAUAQEA"
            "AAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oA"
            "DAMBAAIRAxEAPwCwy2tapUmM6lKXEpKgoggHBB+1QxqfbqKTJAK"
            "iBkAA/9k="
        )


async def _mock_run(workflow: dict, delay: float = 1.5) -> dict[str, Any]:
    """Simulate a short AI processing delay and return a mock image."""
    await asyncio.sleep(delay)
    logger.info("[MOCK] RunPod call intercepted — returning placeholder image")
    image_b64 = _make_mock_image()
    return {
        "image_base64": image_b64,
        "result_url": None,  # services handle None gracefully via local save
        "prompt_id": "mock-00000000-0000-0000-0000-000000000000",
        "elapsed_s": delay,
    }


# ═══════════════════════════════════════════════════════════════════════════════
#  RunPodClient
# ═══════════════════════════════════════════════════════════════════════════════


class RunPodClient:
    """
    Async client for RunPod Serverless endpoints.

    Usage::

        client = RunPodClient()

        # Fire-and-wait (RunPod handles timeout server-side, ≤30 s cap)
        result = await client.run_sync(workflow_dict)

        # Queue + poll (no server-side cap, suitable for final render)
        result = await client.run_async(workflow_dict, timeout=300)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        endpoint_id: Optional[str] = None,
    ) -> None:
        self._api_key = api_key or settings.RUNPOD_API_KEY
        self._endpoint_id = endpoint_id or settings.RUNPOD_ENDPOINT_ID
        self._base_url = _BASE_URL_TMPL.format(endpoint_id=self._endpoint_id)
        self._headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }

    # ── Public API ────────────────────────────────────────────────────────────

    async def run_sync(
        self,
        workflow: dict[str, Any],
        timeout: int = 120,
        upload_result: bool = True,
    ) -> dict[str, Any]:
        """
        Submit a workflow via /runsync and block until RunPod returns.

        Args:
            workflow:       ComfyUI API-format workflow dict.
            timeout:        Max seconds to wait (passed to the handler; RunPod
                            enforces its own ≤30 s server-side cap for /runsync,
                            so use run_async for longer jobs).
            upload_result:  Ask the handler to upload the result to S3.

        Returns:
            Handler output dict: ``{image_base64, result_url?, prompt_id, elapsed_s}``.

        Raises:
            RunPodJobError:     Handler reported an error.
            RunPodTimeoutError: Request timed out.
            RunPodError:        Unexpected HTTP / network error.
        """
        if _is_mock_mode():
            return await _mock_run(workflow)

        payload = {
            "input": {
                "workflow": workflow,
                "timeout": timeout,
                "upload_result": upload_result,
            }
        }
        url = f"{self._base_url}/runsync"
        return await self._post_with_retry(url, payload, http_timeout=timeout + 30)

    async def run_async(
        self,
        workflow: dict[str, Any],
        timeout: int = 120,
        upload_result: bool = True,
    ) -> dict[str, Any]:
        """
        Queue a workflow via /run, then poll /status/{id} until done.

        Args:
            workflow:       ComfyUI API-format workflow dict.
            timeout:        Max seconds to wait for job completion (polling).
            upload_result:  Ask the handler to upload the result to S3.

        Returns:
            Handler output dict: ``{image_base64, result_url?, prompt_id, elapsed_s}``.

        Raises:
            RunPodJobError:     Job status is FAILED.
            RunPodTimeoutError: Job did not complete within *timeout* seconds.
            RunPodError:        Unexpected HTTP / network error.
        """
        if _is_mock_mode():
            return await _mock_run(workflow)

        payload = {
            "input": {
                "workflow": workflow,
                "timeout": timeout,
                "upload_result": upload_result,
            }
        }
        url = f"{self._base_url}/run"

        # 1. Submit
        data = await self._post_with_retry(url, payload, http_timeout=30)
        job_id: str = data.get("id", "")
        if not job_id:
            raise RunPodError(f"RunPod did not return a job ID: {data}")

        logger.info("RunPod job queued: id=%s", job_id)

        # 2. Poll until terminal state
        return await self._poll_until_done(job_id, timeout)

    async def get_job_status(self, job_id: str) -> dict[str, Any]:
        """
        Fetch the current status of a queued job.

        Returns:
            RunPod status dict, e.g.::

                {"id": "...", "status": "COMPLETED", "output": {...}}
        """
        url = f"{self._base_url}/status/{job_id}"
        connector = aiohttp.TCPConnector(limit=5)
        async with aiohttp.ClientSession(
            headers=self._headers, connector=connector
        ) as session:
            async with session.get(
                url, timeout=aiohttp.ClientTimeout(total=15)
            ) as resp:
                resp.raise_for_status()
                return await resp.json()

    # ── Internal helpers ──────────────────────────────────────────────────────

    async def _post_with_retry(
        self,
        url: str,
        payload: dict[str, Any],
        http_timeout: int = 150,
    ) -> dict[str, Any]:
        """
        POST *payload* to *url* with up to MAX_RETRIES retries on transient errors.

        Retries on:
          - aiohttp.ClientError (network failures)
          - HTTP 5xx responses

        Raises:
            RunPodError on non-retryable errors or exhausted retries.
        """
        last_exc: Optional[Exception] = None
        backoff = 2  # seconds

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                connector = aiohttp.TCPConnector(limit=5)
                async with aiohttp.ClientSession(
                    headers=self._headers, connector=connector
                ) as session:
                    async with session.post(
                        url,
                        json=payload,
                        timeout=aiohttp.ClientTimeout(total=http_timeout),
                    ) as resp:
                        if resp.status >= 500:
                            body = await resp.text()
                            raise RunPodError(
                                f"RunPod HTTP {resp.status}: {body[:200]}"
                            )
                        resp.raise_for_status()
                        data: dict = await resp.json()

                # Check for RunPod-level error in the response body
                status = data.get("status", "")
                if status == "FAILED":
                    err = data.get("error", "unknown error")
                    raise RunPodJobError(f"RunPod job FAILED: {err}")

                return data

            except (RunPodJobError, asyncio.TimeoutError) as exc:
                # Non-retryable
                raise RunPodError(str(exc)) from exc

            except (aiohttp.ClientError, RunPodError) as exc:
                last_exc = exc
                if attempt < MAX_RETRIES:
                    logger.warning(
                        "RunPod request failed (attempt %d/%d): %s — retrying in %ds",
                        attempt,
                        MAX_RETRIES,
                        exc,
                        backoff,
                    )
                    await asyncio.sleep(backoff)
                    backoff *= 2
                else:
                    logger.error(
                        "RunPod request failed after %d attempts: %s", MAX_RETRIES, exc
                    )

        raise RunPodError(
            f"RunPod request failed after {MAX_RETRIES} attempts"
        ) from last_exc

    async def _poll_until_done(self, job_id: str, timeout: int) -> dict[str, Any]:
        """
        Poll /status/{job_id} until the job reaches a terminal state.

        Terminal states: COMPLETED, FAILED, CANCELLED, TIMED_OUT

        Returns:
            Job ``output`` dict on COMPLETED.

        Raises:
            RunPodTimeoutError: Deadline exceeded before terminal state.
            RunPodJobError:     Job ended in FAILED / CANCELLED / TIMED_OUT.
        """
        deadline = time.monotonic() + timeout
        consecutive_errors = 0

        while time.monotonic() < deadline:
            try:
                data = await self.get_job_status(job_id)
                consecutive_errors = 0
            except Exception as exc:
                consecutive_errors += 1
                logger.warning(
                    "Status poll error for job %s (attempt %d): %s",
                    job_id,
                    consecutive_errors,
                    exc,
                )
                if consecutive_errors >= 5:
                    raise RunPodError(
                        f"Too many consecutive poll errors for job {job_id}"
                    ) from exc
                await asyncio.sleep(POLL_INTERVAL)
                continue

            status: str = data.get("status", "")
            logger.debug("Job %s status: %s", job_id, status)

            if status == "COMPLETED":
                output = data.get("output")
                if output is None:
                    raise RunPodJobError(f"Job {job_id} COMPLETED but output is None")
                # Check if our handler itself returned an error dict
                if isinstance(output, dict) and "error" in output:
                    raise RunPodJobError(
                        f"Handler error: {output['error']} (code={output.get('code')})"
                    )
                return output

            if status in ("FAILED", "CANCELLED", "TIMED_OUT"):
                err = data.get("error", status)
                raise RunPodJobError(
                    f"RunPod job {job_id} ended with status={status}: {err}"
                )

            # IN_QUEUE, IN_PROGRESS — keep polling
            await asyncio.sleep(POLL_INTERVAL)

        raise RunPodTimeoutError(
            f"RunPod job {job_id} did not complete within {timeout}s"
        )
