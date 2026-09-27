from client import MODEL, client

print("Models:", ", ".join(model.id for model in client.models.list().data))

completion = client.chat.completions.create(model=MODEL, messages=[{"role": "user", "content": "Reply with exactly: pong"}])
print("Chat completion:", completion.choices[0].message.content)
