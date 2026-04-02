"""
The Circle — RunPod Serverless Handler for ComfyUI
===================================================

Job input schema
----------------
{
  "workflow": {...},          # ComfyUI API-format workflow JSON (required)
  "timeout":  120,            # seconds to wait for completion (optional, default 120)
  "upload_result": true       # upload result image to S3 (optional, default true)
}

Job output schema (success)
---------------------------
{
  "image_base64": "...",      # JPEG bytes, base64-encoded
  "result_url":   "...",      # S3 public URL (null if S3 not configured)
  "prompt_id":    "...",      # ComfyUI internal prompt ID (useful for debugging)
  "elapsed_s":    12.3        # wall-clock seconds from queue to result
}

Job output schema (error)
--------------------------
{
  "error":   "description",
  "code":    "TIMEOUT | NODE_ERROR | NO_OUTPUT | EXECUTION_ERROR | UNEXPECTED"
}
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import time
import uuid
from typing import Any, Optional

import aiohttp
import boto3
import runpod
from botocore.exceptions import ClientError

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("the_circle.handler")

# ── Configuration from environment ───────────────────────────────────────────
COMFYUI_URL: str     = os.getenv("COMFYUI_URL", "http://127.0.0.1:8188")
DEFAULT_TIMEOUT: int = int(os.getenv("TIMEOUT_DEFAULT", "120"))
FINAL_TIMEOUT: int   = int(os.getenv("TIMEOUT_FINAL_RENDER", "300"))
S3_BUCKET: str       = os.getenv("S3_BUCKET_NAME", "")
AWS_REGION: str      = os.getenv("AWS_REGION", "ap-northeast-2")
POLL_INTERVAL: float = float(os.getenv("POLL_INTERVAL_S", "2.0"))


# ═══════════════════════════════════════════════════════════════════════════════
#  ComfyUI API helpers
# ═══════════════════════════════════════════════════════════════════════════════

async def queue_prompt(
    workflow: dict[str, Any],
    client_id: str,
    session: aiohttp.ClientSession,
) -> str:
    """
    Submit a workflow to ComfyUI's /prompt endpoint.

    Args:
        workflow:  ComfyUI API-format workflow JSON.
        client_id: Unique identifier for this job (for WebSocket if needed).
        session:   Shared aiohttp session.

    Returns:
        prompt_id — ComfyUI's internal identifier for this queued prompt.

    Raises:
        ValueError: If ComfyUI reports node validation errors.
        aiohttp.ClientResponseError: On HTTP errors.
    """
    payload = {"prompt": workflow, "client_id": client_id}
    async with session.post(
        f"{COMFYUI_URL}/prompt",
        json=payload,
        timeout=aiohttp.ClientTimeout(total=30),
    ) as resp:
        resp.raise_for_status()
        data: dict = await resp.json()

    node_errors: dict = data.get("node_errors", {})
    if node_errors:
        raise ValueError(f"ComfyUI node errors: {json.dumps(node_errors, indent=2)}")

    prompt_id: str = data["prompt_id"]
    logger.info("Queued prompt_id=%s", prompt_id)
    return prompt_id


async def wait_for_completion(
    prompt_id: str,
    timeout: int,
    session: aiohttp.ClientSession,
) -> dict[str, Any]:
    """
    Poll ComfyUI's /history endpoint until the prompt finishes or times out.

    Args:
        prompt_id: ComfyUI prompt identifier.
        timeout:   Maximum seconds to wait.
        session:   Shared aiohttp session.

    Returns:
        outputs — dict mapping node_id → node_outputs (contains image filenames).

    Raises:
        TimeoutError:  Prompt did not finish within *timeout* seconds.
        RuntimeError:  ComfyUI reported an execution error.
    """
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        async with session.get(
            f"{COMFYUI_URL}/history/{prompt_id}",
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            resp.raise_for_status()
            history: dict = await resp.json()

        if prompt_id not in history:
            # Job still in queue or running
            await asyncio.sleep(POLL_INTERVAL)
            continue

        entry  = history[prompt_id]
        status = entry.get("status", {})
        status_str: str = status.get("status_str", "")

        if status_str == "error":
            error_msgs = [
                m[1].get("exception_message", str(m[1]))
                for m in status.get("messages", [])
                if isinstance(m, (list, tuple)) and len(m) > 0 and m[0] == "execution_error"
            ]
            raise RuntimeError(
                "ComfyUI execution error: " + ("; ".join(error_msgs) or "unknown")
            )

        if status_str == "success":
            return entry.get("outputs", {})

        # Any other status (e.g. "started") — keep polling
        await asyncio.sleep(POLL_INTERVAL)

    raise TimeoutError(
        f"ComfyUI prompt {prompt_id} did not complete within {timeout}s"
    )


async def fetch_first_image(
    outputs: dict[str, Any],
    session: aiohttp.ClientSession,
) -> Optional[bytes]:
    """
    Extract and download the first image from ComfyUI outputs.

    ComfyUI node outputs look like:
      {"9": {"images": [{"filename": "foo.png", "subfolder": "", "type": "output"}]}}

    Args:
        outputs: Outputs dict from wait_for_completion().
        session: Shared aiohttp session.

    Returns:
        Raw image bytes, or None if no image was found.
    """
    for node_id, node_out in outputs.items():
        images: list = node_out.get("images", [])
        if not images:
            continue
        img_info = images[0]
        params = {
            "filename": img_info["filename"],
            "subfolder": img_info.get("subfolder", ""),
            "type": img_info.get("type", "output"),
        }
        async with session.get(
            f"{COMFYUI_URL}/view",
            params=params,
            timeout=aiohttp.ClientTimeout(total=60),
        ) as resp:
            resp.raise_for_status()
            logger.info(
                "Downloaded output image from node %s: %s (%d bytes)",
                node_id,
                img_info["filename"],
                int(resp.headers.get("Content-Length", 0)),
            )
            return await resp.read()

    return None


# ═══════════════════════════════════════════════════════════════════════════════
#  S3 upload
# ═══════════════════════════════════════════════════════════════════════════════

def upload_result_to_s3(image_bytes: bytes, job_id: str) -> Optional[str]:
    """
    Upload a result image to S3 and return its public URL.

    Args:
        image_bytes: Raw image bytes (JPEG or PNG).
        job_id:      RunPod job ID used as the S3 object name.

    Returns:
        Public HTTPS URL, or None if S3 is not configured or upload fails.
    """
    if not S3_BUCKET:
        logger.debug("S3_BUCKET_NAME not set — skipping S3 upload")
        return None

    key = f"results/comfyui/{job_id}.jpg"
    s3 = boto3.client(
        "s3",
        region_name=AWS_REGION,
        aws_access_key_id=os.getenv("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.getenv("AWS_SECRET_ACCESS_KEY"),
    )
    try:
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=image_bytes,
            ContentType="image/jpeg",
        )
        url = f"https://{S3_BUCKET}.s3.{AWS_REGION}.amazonaws.com/{key}"
        logger.info("Uploaded result to S3: %s", url)
        return url
    except ClientError as exc:
        logger.warning("S3 upload failed: %s", exc)
        return None


# ═══════════════════════════════════════════════════════════════════════════════
#  Core async job processor
# ═══════════════════════════════════════════════════════════════════════════════

async def process_job(job: dict[str, Any]) -> dict[str, Any]:
    """
    Async implementation of the RunPod job processor.

    Workflow:
      1. Parse and validate input
      2. Queue workflow on local ComfyUI
      3. Poll until done (or timeout)
      4. Download result image
      5. Optionally upload to S3
      6. Return { image_base64, result_url?, prompt_id, elapsed_s }

    Args:
        job: RunPod job dict containing at least {"input": {...}}.

    Returns:
        Output dict for RunPod (success or error shape).
    """
    t_start = time.monotonic()
    job_id  = job.get("id") or str(uuid.uuid4())

    # ── Parse input ───────────────────────────────────────────────────────────
    input_data: dict     = job.get("input", {})
    workflow: Optional[dict] = input_data.get("workflow")
    timeout: int         = int(input_data.get("timeout", DEFAULT_TIMEOUT))
    should_upload: bool  = bool(input_data.get("upload_result", True))

    if not workflow:
        return {"error": "Field 'workflow' is required in job input.", "code": "MISSING_WORKFLOW"}

    logger.info(
        "Processing job %s | timeout=%ds | workflow_nodes=%d",
        job_id, timeout, len(workflow),
    )

    client_id = str(uuid.uuid4())

    # ── Submit + poll + download in a single session ──────────────────────────
    connector = aiohttp.TCPConnector(limit=10)
    async with aiohttp.ClientSession(connector=connector) as session:
        # 1. Queue
        try:
            prompt_id = await queue_prompt(workflow, client_id, session)
        except ValueError as exc:
            return {"error": str(exc), "code": "NODE_ERROR"}
        except Exception as exc:
            logger.exception("Failed to queue prompt")
            return {"error": f"ComfyUI queue error: {exc}", "code": "QUEUE_ERROR"}

        # 2. Wait for completion
        try:
            outputs = await wait_for_completion(prompt_id, timeout, session)
        except TimeoutError as exc:
            return {"error": str(exc), "code": "TIMEOUT"}
        except RuntimeError as exc:
            return {"error": str(exc), "code": "EXECUTION_ERROR"}
        except Exception as exc:
            logger.exception("Unexpected error while polling")
            return {"error": f"Poll error: {exc}", "code": "UNEXPECTED"}

        # 3. Download image
        try:
            image_bytes = await fetch_first_image(outputs, session)
        except Exception as exc:
            logger.exception("Failed to fetch result image")
            return {"error": f"Image fetch error: {exc}", "code": "FETCH_ERROR"}

    if not image_bytes:
        return {"error": "No output image found in ComfyUI outputs.", "code": "NO_OUTPUT"}

    # 4. S3 upload (non-blocking — failure is non-fatal)
    result_url: Optional[str] = None
    if should_upload:
        result_url = upload_result_to_s3(image_bytes, job_id)

    elapsed = round(time.monotonic() - t_start, 2)
    logger.info("Job %s completed in %.1fs", job_id, elapsed)

    output: dict[str, Any] = {
        "image_base64": base64.b64encode(image_bytes).decode("utf-8"),
        "prompt_id":    prompt_id,
        "elapsed_s":    elapsed,
    }
    if result_url:
        output["result_url"] = result_url

    return output


# ═══════════════════════════════════════════════════════════════════════════════
#  RunPod entry point
# ═══════════════════════════════════════════════════════════════════════════════

async def handler(job: dict[str, Any]) -> dict[str, Any]:
    """
    RunPod Serverless handler entry point (async).

    RunPod calls this function for each job.  Because ComfyUI is already
    running (started in start.sh before this process), we only need to:
      - Submit the workflow via the ComfyUI HTTP API
      - Wait for completion
      - Return the result

    Args:
        job: RunPod job dictionary (see module docstring for schema).

    Returns:
        Output dictionary (see module docstring for schema).
    """
    return await process_job(job)


if __name__ == "__main__":
    logger.info("Registering RunPod Serverless handler...")
    runpod.serverless.start({"handler": handler})
