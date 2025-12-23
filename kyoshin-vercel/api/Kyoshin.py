import requests
import numpy as np
from PIL import Image
from io import BytesIO
import json
from datetime import datetime

def acc_to_shindo(acc):
    if acc < 0.8: return "0"
    if acc < 2.5: return "1"
    if acc < 8: return "2"
    if acc < 25: return "3"
    if acc < 80: return "4"
    if acc < 140: return "5-"
    if acc < 250: return "5+"
    if acc < 440: return "6-"
    if acc < 800: return "6+"
    return "7"

def handler(request, response):
    try:
        img_url = "https://www.kmoni.bosai.go.jp/data/map_img/RealTimeImg/jma_sindo.png"
        img = Image.open(
            BytesIO(requests.get(img_url, timeout=5).content)
        ).convert("RGB")

        arr = np.array(img)
        red = arr[:, :, 0].astype(float)

        max_acc = float(red.max()) * 2.5

        result = {
            "time": datetime.utcnow().isoformat(),
            "max_acc": round(max_acc, 2),
            "shindo": acc_to_shindo(max_acc)
        }

        response.status_code = 200
        response.headers["Content-Type"] = "application/json"
        response.write(json.dumps(result))

    except Exception as e:
        response.status_code = 500
        response.write(json.dumps({"error": str(e)}))
