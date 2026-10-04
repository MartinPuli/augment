/** COCO-80 class names, in the contiguous index order used by YOLO and D-FINE COCO heads. */
export const COCO_LABELS = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
  "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
  "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
  "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
  "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
  "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
  "scissors", "teddy bear", "hair drier", "toothbrush",
] as const;

export type CocoLabel = (typeof COCO_LABELS)[number];

/** Loose aliases so the agent can say "cars", "people", "vehicles"... */
const ALIASES: Record<string, string[]> = {
  vehicle: ["car", "truck", "bus", "motorcycle"],
  vehicles: ["car", "truck", "bus", "motorcycle"],
  cars: ["car"],
  trucks: ["truck"],
  buses: ["bus"],
  people: ["person"],
  persons: ["person"],
  person: ["person"],
  human: ["person"],
  humans: ["person"],
  me: ["person"],
  pedestrian: ["person"],
  pedestrians: ["person"],
  bike: ["bicycle", "motorcycle"],
  bikes: ["bicycle", "motorcycle"],
  motorbike: ["motorcycle"],
  phone: ["cell phone"],
  dogs: ["dog"],
  cats: ["cat"],
  boats: ["boat"],
};

/** Normalize a user/agent supplied class filter to COCO labels. Unknown names are dropped. */
export function normalizeClasses(classes: readonly string[] | undefined | null): string[] | null {
  if (!classes || classes.length === 0) return null;
  const out = new Set<string>();
  for (const raw of classes) {
    const c = String(raw).trim().toLowerCase();
    if (!c) continue;
    if ((COCO_LABELS as readonly string[]).includes(c)) out.add(c);
    else if (ALIASES[c]) for (const a of ALIASES[c]) out.add(a);
    else if (c.endsWith("s") && (COCO_LABELS as readonly string[]).includes(c.slice(0, -1))) out.add(c.slice(0, -1));
  }
  return out.size ? [...out] : null;
}
