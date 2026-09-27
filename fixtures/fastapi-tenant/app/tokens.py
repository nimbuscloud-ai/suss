def decode_tenant(token: str) -> str:
    return token.split(":")[0]
