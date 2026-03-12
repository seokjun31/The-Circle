/**
 * Assembles a ComfyUI workflow JSON for apartment interior rendering.
 *
 * Pipeline:
 *   1-2.  Load original image + rough hint mask (from canvas strokes)
 *   17-18. SAM2 refines the rough mask into a precise segmentation mask
 *   3-5.  ControlNet (depth) guidance
 *   6-9.  Checkpoint + LoRA + CLIP text prompts
 *   10.   VAEEncodeForInpaint  ← uses SAM2 precise mask
 *   11-13. KSampler → VAEDecode → SaveImage
 *   14-16. (optional) IP-Adapter for material texture reference
 */

function buildWorkflow({ imageBase64, maskBase64, prompt, negativePrompt, materialImageBase64 }) {
  const workflow = {
    // ── Node 1: Load original image ────────────────────────────────────────
    "1": {
      "class_type": "ETN_LoadImageBase64",
      "inputs": {
        "image": imageBase64
      }
    },

    // ── Node 2: Load rough hint mask (canvas strokes) ──────────────────────
    //   This white/black mask is used only as a *prompt* for SAM2.
    //   The precise mask that drives inpainting comes from node 18.
    "2": {
      "class_type": "ETN_LoadMaskBase64",
      "inputs": {
        "mask": maskBase64
      }
    },

    // ── Node 17: Load SAM2 model ───────────────────────────────────────────
    "17": {
      "class_type": "SAM2ModelLoader",
      "inputs": {
        "model": "sam2_hiera_large.pt",
        "device": "cuda",
        "dtype": "bfloat16"
      }
    },

    // ── Node 18: SAM2 Segmentation ─────────────────────────────────────────
    //   Takes the original image + rough hint mask → outputs precise mask.
    //   The model traces the object/floor boundary automatically.
    "18": {
      "class_type": "Sam2Segmentation",
      "inputs": {
        "sam2_model": ["17", 0],
        "image": ["1", 0],
        "mask": ["2", 0]
      }
    },

    // ── Node 3: Load ControlNet model (depth) ──────────────────────────────
    "3": {
      "class_type": "ControlNetLoader",
      "inputs": {
        "control_net_name": "control_v11f1p_sd15_depth.pth"
      }
    },

    // ── Node 4: Depth map preprocessor ────────────────────────────────────
    "4": {
      "class_type": "MiDaS-DepthMapPreprocessor",
      "inputs": {
        "image": ["1", 0],
        "a": 6.283185307179586,
        "bg_threshold": 0.1
      }
    },

    // ── Node 5: Apply ControlNet ───────────────────────────────────────────
    "5": {
      "class_type": "ControlNetApplyAdvanced",
      "inputs": {
        "positive": ["8", 0],
        "negative": ["9", 0],
        "control_net": ["3", 0],
        "image": ["4", 0],
        "strength": 0.75,
        "start_percent": 0,
        "end_percent": 0.85
      }
    },

    // ── Node 6: Load checkpoint (SD1.5 inpainting) ─────────────────────────
    "6": {
      "class_type": "CheckpointLoaderSimple",
      "inputs": {
        "ckpt_name": "sd-v1-5-inpainting.ckpt"
      }
    },

    // ── Node 7: Load LoRA ──────────────────────────────────────────────────
    "7": {
      "class_type": "LoraLoader",
      "inputs": {
        "model": ["6", 0],
        "clip": ["6", 1],
        "lora_name": "korea-apartment-style_v1.safetensors",
        "strength_model": 0.8,
        "strength_clip": 0.8
      }
    },

    // ── Node 8: Positive prompt ────────────────────────────────────────────
    "8": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": prompt,
        "clip": ["7", 1]
      }
    },

    // ── Node 9: Negative prompt ────────────────────────────────────────────
    "9": {
      "class_type": "CLIPTextEncode",
      "inputs": {
        "text": negativePrompt,
        "clip": ["7", 1]
      }
    },

    // ── Node 10: VAE Encode for Inpainting ────────────────────────────────
    //   Uses the SAM2-refined precise mask (node 18), not the raw hint mask.
    "10": {
      "class_type": "VAEEncodeForInpaint",
      "inputs": {
        "pixels": ["1", 0],
        "vae": ["6", 2],
        "mask": ["18", 0],
        "grow_mask_by": 6
      }
    },

    // ── Node 11: KSampler ─────────────────────────────────────────────────
    "11": {
      "class_type": "KSampler",
      "inputs": {
        "model": ["7", 0],
        "positive": ["5", 0],
        "negative": ["5", 1],
        "latent_image": ["10", 0],
        "seed": Math.floor(Math.random() * 2 ** 32),
        "steps": 30,
        "cfg": 7.5,
        "sampler_name": "dpmpp_2m",
        "scheduler": "karras",
        "denoise": 1.0
      }
    },

    // ── Node 12: VAE Decode ────────────────────────────────────────────────
    "12": {
      "class_type": "VAEDecode",
      "inputs": {
        "samples": ["11", 0],
        "vae": ["6", 2]
      }
    },

    // ── Node 13: Save result ───────────────────────────────────────────────
    "13": {
      "class_type": "SaveImage",
      "inputs": {
        "images": ["12", 0],
        "filename_prefix": "interior_render"
      }
    }
  };

  // ── Nodes 14-16: IP-Adapter (optional, when material texture provided) ──
  if (materialImageBase64) {
    workflow["14"] = {
      "class_type": "ETN_LoadImageBase64",
      "inputs": { "image": materialImageBase64 }
    };
    workflow["15"] = {
      "class_type": "IPAdapterModelLoader",
      "inputs": { "ipadapter_file": "ip-adapter_sd15.bin" }
    };
    workflow["16"] = {
      "class_type": "IPAdapterApply",
      "inputs": {
        "ipadapter": ["15", 0],
        "clip_vision": ["6", 0],
        "image": ["14", 0],
        "model": ["7", 0],
        "weight": 0.6,
        "noise": 0.0,
        "weight_type": "original",
        "start_at": 0.0,
        "end_at": 0.9
      }
    };
    // Route the IP-Adapter enhanced model into KSampler
    workflow["11"].inputs.model = ["16", 0];
  }

  return workflow;
}

module.exports = { buildWorkflow };
