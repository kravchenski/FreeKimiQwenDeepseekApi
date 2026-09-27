from client import MODEL, client

response = client.chat.completions.create(
    model=MODEL,
    messages=[
        {"role": "system", "content": "You are a concise assistant. Answer in at most two sentences."},
        {"role": "user", "content": "Why is the sky blue?"},
    ],
)
print(response.choices[0].message.content)
