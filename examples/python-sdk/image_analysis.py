import os

from client import client

IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png"

response = client.chat.completions.create(
    model=os.environ.get("FREEAPI_MODEL", "qwen3.7-plus"),
    messages=[{
        "role": "user",
        "content": [
            {"type": "text", "text": "Describe this image in detail."},
            {"type": "image_url", "image_url": {"url": IMAGE_URL}},
        ],
    }],
)
print(response.choices[0].message.content)
