import json
import os

import httpx

base_url = os.environ.get("FREEAPI_BASE_URL", "http://localhost:3260/v1")
headers = {"Authorization": f"Bearer {os.environ['GATEWAY_API_KEY']}"} if os.environ.get("GATEWAY_API_KEY") else {}
body = {
    "model": os.environ.get("FREEAPI_MODEL", "auto"),
    "stream": True,
    "messages": [{"role": "user", "content": "Write a short story about space in five sentences."}],
}

with httpx.stream("POST", f"{base_url}/chat/completions", headers=headers, json=body, timeout=120) as response:
    response.raise_for_status()
    for line in response.iter_lines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        delta = json.loads(line[6:])["choices"][0]["delta"].get("content")
        if delta:
            print(delta, end="", flush=True)
print()
