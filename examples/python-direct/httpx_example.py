import os

import httpx

base_url = os.environ.get("FREEAPI_BASE_URL", "http://localhost:3260/v1")
headers = {"Authorization": f"Bearer {os.environ['GATEWAY_API_KEY']}"} if os.environ.get("GATEWAY_API_KEY") else {}

response = httpx.post(
    f"{base_url}/chat/completions",
    headers=headers,
    json={"model": os.environ.get("FREEAPI_MODEL", "auto"), "messages": [{"role": "user", "content": "Hello! Tell me about yourself."}]},
    timeout=120,
)
response.raise_for_status()
print(response.json()["choices"][0]["message"]["content"])
