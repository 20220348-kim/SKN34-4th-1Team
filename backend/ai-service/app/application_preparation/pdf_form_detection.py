"""Local FFDetr inputs, checked against independently extracted PDF words."""
import hashlib
import math
from pathlib import Path

MODEL_PATH = Path("/opt/document-tools/ffdetr/FFDetr.pth")
MODEL_SHA256 = "f852e1bac18c8f435b82270fc8ff8e2ca4a2cd8869c411fa8f473f16e69585ef"


def detect_inputs(image_paths: list[str]) -> dict:
    from PIL import Image
    import torch
    from rfdetr import RFDETRMedium

    if not 1 <= len(image_paths) <= 50:
        raise ValueError("PDF_DETECTION_PAGE_LIMIT")
    paths = [Path(value) for value in image_paths]
    root = Path.cwd().resolve()
    if any(path.is_symlink() or path.resolve().parent != root or not path.is_file() for path in paths):
        raise ValueError("PDF_DETECTION_PATH")
    if hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError("PDF_DETECTION_MODEL_HASH")
    torch.set_num_threads(2)
    model = RFDETRMedium(pretrain_weights=str(MODEL_PATH), device="cpu")
    pages = []
    with torch.inference_mode():
        for index, path in enumerate(paths):
            with Image.open(path) as source:
                if source.format != "PNG" or source.width * source.height > 20_000_000:
                    raise ValueError("PDF_DETECTION_IMAGE_LIMIT")
                image = source.convert("RGB")
            detections = model.predict(image, threshold=.4).with_nms(threshold=.1, class_agnostic=True)
            items = []
            for kind, confidence, box in zip(detections.class_id, detections.confidence, detections.xyxy):
                items.append({"kind": int(kind), "confidence": float(confidence), "box": {
                    "x": float(box[0] / image.width), "y": float(box[1] / image.height),
                    "width": float((box[2] - box[0]) / image.width),
                    "height": float((box[3] - box[1]) / image.height)}})
            image.close()
            pages.append({"page": index, "detections": items})
    return {"page_count": len(pages), "modelSha256": MODEL_SHA256, "pages": pages}


def checked_regions(detections: list[dict], words: list[dict], ruled_regions: list[dict]) -> list[dict]:
    def bounds(box):
        return (box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"])

    def intersection(a, b):
        return (max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3]))

    def area(box):
        return max(0, box[2]-box[0]) * max(0, box[3]-box[1])

    result = []
    for detection in sorted(detections, key=lambda item: (item["box"]["y"], item["box"]["x"])):
        # Printed consent controls and signatures need a separate explicit contract.
        if detection["kind"] != 0 or not .4 <= detection["confidence"] <= 1:
            continue
        box = bounds(detection["box"])
        if not all(math.isfinite(value) for value in box) or not (0 <= box[0] < box[2] <= 1 and 0 <= box[1] < box[3] <= 1):
            raise ValueError("PDF_DETECTION_BOX")
        # FFDetr proposes a field; independently measured blank table boundaries
        # supply its final size. Intersecting both would crop short phone rows below
        # the minimum readable height. No region is accepted without a detection.
        parts = [(bounds(region["box"]), region["labels"]) for region in ruled_regions
                 if area(intersection(box, bounds(region["box"]))) >= .65 * area(bounds(region["box"]))]
        if not parts:
            left = [word for word in words if box[0]-.25 <= bounds(word["box"])[2] <= box[0]+.002
                    and min(box[3], bounds(word["box"])[3])-max(box[1], bounds(word["box"])[1]) > .5*word["box"]["height"]]
            if left:
                nearest = max(bounds(word["box"])[2] for word in left)
                left = [word for word in left if bounds(word["box"])[2] >= nearest-.15]
                labels = [" ".join(word["text"] for word in sorted(left, key=lambda w: (w["box"]["y"], w["box"]["x"])))]
            else:
                above = [word for word in words if 0 <= box[1]-bounds(word["box"])[3] <= .04
                         and min(box[2], bounds(word["box"])[2]) > max(box[0], bounds(word["box"])[0])]
                nearest = max((bounds(word["box"])[3] for word in above), default=0)
                labels = [" ".join(word["text"] for word in sorted(above, key=lambda w: w["box"]["x"])
                                   if bounds(word["box"])[3] >= nearest-.006)] if above else []
            parts = [(box, labels)]
        for region, labels in parts:
            if not area(region) or any(area(intersection(region, bounds(word["box"]))) > 0 for word in words):
                continue
            if any(area(intersection(region, bounds(previous["box"]))) > 0 for previous in result):
                raise ValueError("PDF_DETECTION_OVERLAP")
            result.append({"id": f"ffdetr-{len(result)}", "labels": labels, "confidence": detection["confidence"],
                           "box": {"x": region[0], "y": region[1], "width": region[2]-region[0], "height": region[3]-region[1]}})
    return result
