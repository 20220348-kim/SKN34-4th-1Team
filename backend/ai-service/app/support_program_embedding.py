import tiktoken


def prepare_embedding_inputs(texts: list[str]) -> list[str]:
    """두 공고 색인이 공유하는 토큰 상한 처리. 호출부에서 작업 스레드로 실행한다."""
    encoding = tiktoken.get_encoding("cl100k_base")
    inputs: list[str] = []
    for text in texts:
        tokens = encoding.encode_ordinary(text)
        if len(tokens) > 8191:
            text = encoding.decode(tokens[:8191])
            while len(encoding.encode_ordinary(text)) > 8191:
                text = text[:-1]
        inputs.append(text)
    return inputs
