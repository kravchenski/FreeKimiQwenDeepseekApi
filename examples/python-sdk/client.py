import os

from openai import OpenAI

client = OpenAI(
    base_url=os.environ.get("FREEAPI_BASE_URL", "http://localhost:3260/v1"),
    api_key=os.environ.get("GATEWAY_API_KEY") or "not-needed",
)
MODEL = os.environ.get("FREEAPI_MODEL", "auto")
