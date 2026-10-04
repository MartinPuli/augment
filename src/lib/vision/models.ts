/**
 * Detector model registry. Weights are NEVER committed: they are fetched at runtime from
 * Hugging Face (CORS-enabled CDN) and cached by the browser HTTP cache.
 *
 * Default: D-FINE nano (Apache-2.0, COCO-80, NMS-free DETR head, 15 MB fp32).
 * Optional: YOLOv10n (AGPL-3.0 — Ultralytics/THU-MIG). Only used when explicitly selected.
 */
export type ModelFamily = "dfine" | "yolov10";

export interface VisionModelSpec {
  id: string;
  name: string;
  family: ModelFamily;
  url: string;
  /** Optional same-origin copy (scripts/vision-fetch-model.ts, git-ignored); tried before `url`. */
  local: string;
  /** Bytes (for progress UI). */
  bytes: number;
  license: string;
  license_url: string;
  /** Model input side (square). */
  input: number;
  /** "stretch" = plain resize (DETR processors); "letterbox" = aspect-preserving pad (YOLO). */
  resize: "stretch" | "letterbox";
  /** Default score threshold. */
  threshold: number;
}

const HF = "https://huggingface.co";

export const VISION_MODELS: Record<string, VisionModelSpec> = {
  "dfine-n": {
    id: "dfine-n",
    name: "D-FINE-N",
    family: "dfine",
    url: `${HF}/onnx-community/dfine_n_coco-ONNX/resolve/main/onnx/model.onnx`,
    local: "/vision/models/dfine-n.onnx",
    bytes: 15_258_358,
    license: "Apache-2.0",
    license_url: `${HF}/ustc-community/dfine-nano-coco`,
    input: 640,
    resize: "stretch",
    threshold: 0.3,
  },
  "yolov10n": {
    id: "yolov10n",
    name: "YOLOv10n",
    family: "yolov10",
    url: `${HF}/onnx-community/yolov10n/resolve/main/onnx/model.onnx`,
    local: "/vision/models/yolov10n.onnx",
    bytes: 9_386_116,
    license: "AGPL-3.0",
    license_url: `${HF}/onnx-community/yolov10n`,
    input: 640,
    resize: "letterbox",
    threshold: 0.3,
  },
};

export const DEFAULT_MODEL_ID = "dfine-n";

export function getModel(id?: string | null): VisionModelSpec {
  return (id && VISION_MODELS[id]) || VISION_MODELS[DEFAULT_MODEL_ID];
}
