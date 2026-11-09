def handler(event, context):
    text = event["arguments"]["text"]
    if not text:
        return []
    return [{"id": "1", "title": text}]
