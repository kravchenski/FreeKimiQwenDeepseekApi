from client import MODEL, client

stream = client.chat.completions.create(
    model=MODEL,
    stream=True,
    messages=[{"role": "user", "content": "Write a short story about space in five sentences."}],
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)
print()
