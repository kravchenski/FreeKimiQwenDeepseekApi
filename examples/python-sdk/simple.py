from client import MODEL, client

response = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "Explain in simple words what artificial intelligence is."}],
)
print(response.choices[0].message.content)
