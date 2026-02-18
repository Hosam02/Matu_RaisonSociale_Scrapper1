import sys
import json
import base64
import cv2
import numpy as np
import pytesseract
import re

pytesseract.pytesseract.tesseract_cmd = r"C:\Users\h.qotbi\AppData\Local\Programs\Tesseract-OCR\tesseract.exe"

CAPTCHA_LEN = 6

def clean_text(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^a-z0-9]", "", s)
    return s

def preprocess(img_bytes: bytes):
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        raise Exception("Failed to decode captcha image")

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Upscale hard
    gray = cv2.resize(gray, None, fx=7, fy=7, interpolation=cv2.INTER_CUBIC)

    # Blur then threshold
    blur = cv2.GaussianBlur(gray, (3, 3), 0)

    # Captcha is white text on black background
    _, th = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Remove tiny noise
    kernel = np.ones((2, 2), np.uint8)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel)

    return th

def ocr_best(img):
    # IMPORTANT:
    # - psm 7 works best for single line
    # - whitelist
    config = "--oem 3 --psm 7 -c tessedit_char_whitelist=abcdefghijklmnopqrstuvwxyz0123456789"

    # image_to_data gives confidence per token
    data = pytesseract.image_to_data(img, config=config, output_type=pytesseract.Output.DICT)

    parts = []
    confs = []

    for i in range(len(data["text"])):
        txt = clean_text(data["text"][i])
        conf = int(float(data["conf"][i])) if data["conf"][i] != "-1" else -1

        if txt:
            parts.append(txt)
            confs.append(conf)

    merged = clean_text("".join(parts))

    # If tesseract merges extra garbage, cut
    if len(merged) > CAPTCHA_LEN:
        merged = merged[:CAPTCHA_LEN]

    return merged

def solve_captcha(base64_image: str) -> str:
    img_bytes = base64.b64decode(base64_image)
    img = preprocess(img_bytes)

    # try both normal + inverted (sometimes helps)
    inv = cv2.bitwise_not(img)

    a = ocr_best(img)
    b = ocr_best(inv)

    # choose the one closer to length 6
    candidates = [a, b]
    candidates.sort(key=lambda x: abs(len(x) - CAPTCHA_LEN))

    best = candidates[0]
    return best

if __name__ == "__main__":
    raw_input = sys.stdin.read().strip()

    try:
        try:
            parsed = json.loads(raw_input)
            base64_image = parsed.get("image") or ""
        except:
            base64_image = raw_input

        if base64_image.startswith("data:image"):
            base64_image = base64_image.split(",", 1)[1]

        if not base64_image:
            raise Exception("No base64 image provided")

        solution = solve_captcha(base64_image)

        print(json.dumps({"success": True, "solution": solution}))

    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
