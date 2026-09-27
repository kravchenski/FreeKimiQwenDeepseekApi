from client import MODEL, client

messages = [{"role": "user", "content": "My name is Alex. Remember it."}]
first = client.chat.completions.create(model=MODEL, messages=messages)
reply = first.choices[0].message.content
print("Assistant:", reply)

messages += [{"role": "assistant", "content": reply}, {"role": "user", "content": "What is my name?"}]
second = client.chat.completions.create(model=MODEL, messages=messages)
print("Assistant:", second.choices[0].message.content)
