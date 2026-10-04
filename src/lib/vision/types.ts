/** A single detection in SOURCE frame pixel coordinates (top-left origin). */
export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  classId: number;
  label: string;
}

export type DetectorBackend = "webgpu" | "wasm" | "none";

export interface DetectorInfo {
  backend: DetectorBackend;
  model: string; // model id
  modelName: string;
  license: string;
}
