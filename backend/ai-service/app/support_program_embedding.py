import tiktoken

MAX_EMBEDDING_REQUEST_TOKENS = 32 * 8191


def prepare_embedding_batches(
    texts: list[str], max_request_tokens: int = MAX_EMBEDDING_REQUEST_TOKENS,
) -> list[tuple[list[str], int]]:
    """전송 문자열의 토큰 수로 배치를 나눈다. 전체 입력 검사는 첫 HTTP 호출 전에 끝낸다."""
    if type(max_request_tokens) is not int or not 1 <= max_request_tokens <= MAX_EMBEDDING_REQUEST_TOKENS:
        raise ValueError("Invalid embedding request token limit")
    encoding = tiktoken.get_encoding("cl100k_base")
    batches: list[tuple[list[str], int]] = []
    batch: list[str] = []
    batch_tokens = 0
    for text in texts:
        tokens = encoding.encode_ordinary(text)
        if len(tokens) > 8191:
            text = encoding.decode(tokens[:8191])
            tokens = encoding.encode_ordinary(text)
            while len(tokens) > 8191:
                text = text[:-1]
                tokens = encoding.encode_ordinary(text)
        if not tokens or len(tokens) > max_request_tokens:
            raise ValueError("Embedding input exceeds the configured request limit or is empty")
        if batch and (len(batch) == 32 or batch_tokens + len(tokens) > max_request_tokens):
            batches.append((batch, batch_tokens))
            batch, batch_tokens = [], 0
        batch.append(text)
        batch_tokens += len(tokens)
    if batch:
        batches.append((batch, batch_tokens))
    return batches


def embedding_usage(response: dict, max_request_tokens: int) -> int:
    """SDK 형 변환 전 사용량을 검증한다. 미보고·상한 초과를 0으로 해석하지 않는다."""
    usage = response.get("usage")
    if (
        not isinstance(usage, dict)
        or type(usage.get("prompt_tokens")) is not int
        or not 0 <= usage["prompt_tokens"] <= max_request_tokens
        or type(usage.get("total_tokens")) is not int
        or usage["total_tokens"] != usage["prompt_tokens"]
    ):
        raise ValueError("Embedding usage is missing or invalid")
    return usage["prompt_tokens"]
