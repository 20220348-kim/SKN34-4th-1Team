import asyncio
import logging
from collections import OrderedDict
from hashlib import sha256
from math import isfinite
from time import monotonic
from uuid import NAMESPACE_URL, uuid5

from openai import AsyncOpenAI
from qdrant_client import AsyncQdrantClient, models

from app.support_program_embedding import prepare_embedding_inputs
from app.support_program_evidence.errors import SupportProgramEvidenceError
from app.support_program_evidence.models import (
    EvidenceChunkIdentity,
    SupportProgramEvidenceBatchRequest,
    SupportProgramEvidenceDocumentChunk,
    SupportProgramEvidenceBatchResponse,
    SupportProgramEvidenceMatch,
    SupportProgramEvidenceSearchRequest,
    SupportProgramEvidenceSearchResponse,
)


logger = logging.getLogger(__name__)
_QUERY_EMBEDDING_CACHE_MAX_SIZE = 256
_CHUNK_EMBEDDING_CACHE_MAX_SIZE = 128
_EMBEDDING_CACHE_TTL_SECONDS = 300


class SupportProgramEvidenceService:
    """공고 상세 원문 청크를 별도 Qdrant collection에 색인하고 근거를 검색한다."""

    def __init__(
        self,
        openai_client: AsyncOpenAI,
        qdrant_client: AsyncQdrantClient,
        *,
        embedding_model: str,
        embedding_dimensions: int,
        embedding_timeout_seconds: float,
    ) -> None:
        self.openai_client = openai_client
        self.qdrant_client = qdrant_client
        self.embedding_model = embedding_model
        self.embedding_dimensions = embedding_dimensions
        self.embedding_timeout_seconds = embedding_timeout_seconds
        configuration_hash = sha256(
            f"{embedding_model}:{embedding_dimensions}:cl100k_base:8191".encode()
        ).hexdigest()[:16]
        self.collection_name = f"govbiz_support_program_evidence_v1_{configuration_hash}"
        self._write_lock = asyncio.Lock()
        # 모델·차원·전처리가 고정된 인스턴스에서만 재사용한다. 키는 원문 대신 해시다.
        self._query_embedding_cache: OrderedDict[str, tuple[float, tuple[float, ...]]] = OrderedDict()
        self._query_embedding_locks: dict[str, tuple[asyncio.Lock, int]] = {}
        self._chunk_embedding_cache: OrderedDict[str, tuple[float, tuple[float, ...]]] = OrderedDict()

    async def index_chunks(
        self,
        request: SupportProgramEvidenceBatchRequest,
    ) -> SupportProgramEvidenceBatchResponse:
        started_at = monotonic()
        stage = "readiness"
        outcome = "failed"
        try:
            async with asyncio.timeout(25), self._write_lock:
                await self._ensure_collection()
                identities = {_point_id(chunk): chunk for chunk in request.chunks}
                existing = await self.qdrant_client.retrieve(
                    collection_name=self.collection_name,
                    ids=list(identities),
                    with_payload=True,
                    with_vectors=False,
                )
                existing_ids: set[str] = set()
                missing_text_ids: list[str] = []
                for point in existing:
                    identity = identities.get(str(point.id))
                    if identity is None or not _payload_matches(point.payload, identity):
                        # 같은 chunk ID·해시를 다른 상세 공고에 재사용하면 안 된다.
                        raise SupportProgramEvidenceError()
                    existing_ids.add(str(point.id))
                    if not isinstance((point.payload or {}).get("text"), str):
                        missing_text_ids.append(str(point.id))
                # 원문 없이 색인된 이전 버전 point에는 벡터를 다시 만들지 않고 원문만 붙인다(문서 묶음 검색용).
                for point_id in missing_text_ids:
                    await self.qdrant_client.set_payload(
                        collection_name=self.collection_name, payload={"text": identities[point_id].text},
                        points=[point_id], wait=True,
                    )
                missing = [
                    chunk
                    for point_id, chunk in identities.items()
                    if point_id not in existing_ids
                ]
                ready_at = monotonic()
                cache_hits = 0
                if missing:
                    stage = "embedding"
                    vectors, cache_hits = await self._embed_chunks([chunk.text for chunk in missing])
                    embedded_at = monotonic()
                    stage = "upsert"
                    points = [
                        models.PointStruct(
                            id=_point_id(chunk),
                            vector=vector,
                            payload={
                                "id": chunk.id,
                                "contentHash": chunk.content_hash,
                                "documentId": chunk.document_id,
                                "order": chunk.order,
                                # 도우미 관심 공고 질문이 청크 원문을 다시 읽을 수 있게 저장한다. 공개 공고 원문이다.
                                "text": chunk.text,
                            },
                        )
                        for chunk, vector in zip(missing, vectors, strict=True)
                    ]
                    result = await self.qdrant_client.upsert(
                        collection_name=self.collection_name,
                        points=points,
                        wait=True,
                    )
                    if result.status != models.UpdateStatus.COMPLETED:
                        raise SupportProgramEvidenceError()
                else:
                    embedded_at = ready_at
                finished_at = monotonic()
                outcome = "completed"
                logger.info(
                    "support_program_evidence_index_completed chunk_count=%d missing_count=%d "
                    "embedding_cache_hits=%d readiness_ms=%d embedding_ms=%d upsert_ms=%d elapsed_ms=%d",
                    len(request.chunks), len(missing), cache_hits,
                    round((ready_at - started_at) * 1000), round((embedded_at - ready_at) * 1000),
                    round((finished_at - embedded_at) * 1000), round((finished_at - started_at) * 1000),
                )
                return SupportProgramEvidenceBatchResponse(indexedCount=len(request.chunks))
        except SupportProgramEvidenceError:
            raise
        except Exception as error:
            raise SupportProgramEvidenceError() from error
        finally:
            if outcome != "completed":
                logger.info(
                    "support_program_evidence_index_failed stage=%s elapsed_ms=%d",
                    stage, round((monotonic() - started_at) * 1000),
                )

    async def search(
        self,
        request: SupportProgramEvidenceSearchRequest,
    ) -> SupportProgramEvidenceSearchResponse:
        started_at = monotonic()
        stage = "readiness"
        outcome = "failed"
        try:
            async with asyncio.timeout(25):
                if not await self.qdrant_client.collection_exists(self.collection_name):
                    raise SupportProgramEvidenceError("EVIDENCE_NOT_READY")
                identities = {
                    _point_id(chunk): chunk for chunk in request.eligible_chunks
                }
                point_ids = list(identities)
                indexed_points = await self.qdrant_client.retrieve(
                    collection_name=self.collection_name,
                    ids=point_ids,
                    with_payload=True,
                    with_vectors=False,
                )
                if len(indexed_points) != len(point_ids):
                    raise SupportProgramEvidenceError("EVIDENCE_NOT_READY")
                for point in indexed_points:
                    identity = identities.get(str(point.id))
                    if identity is None or not _payload_matches(point.payload, identity):
                        # 같은 ID·해시를 다른 documentId로 위장한 요청은 임베딩 전 차단한다.
                        raise SupportProgramEvidenceError()
                ready_at = monotonic()
                stage = "embedding"
                vector, cache_state = await self._embed_query(request.question)
                embedded_at = monotonic()
                stage = "vector_search"
                response = await self.qdrant_client.query_points(
                    collection_name=self.collection_name,
                    query=vector,
                    query_filter=models.Filter(
                        must=[models.HasIdCondition(has_id=point_ids)]
                    ),
                    limit=min(request.limit, len(point_ids)),
                    with_payload=True,
                    with_vectors=False,
                )
                matches: list[SupportProgramEvidenceMatch] = []
                seen: set[str] = set()
                for point in response.points:
                    point_id = str(point.id)
                    identity = identities.get(point_id)
                    if (
                        identity is None
                        or point_id in seen
                        or not _payload_matches(point.payload, identity)
                    ):
                        # HasId filter만 믿지 않고 문서 ID·청크 순서까지 다시 확인한다.
                        raise SupportProgramEvidenceError()
                    seen.add(point_id)
                    matches.append(
                        SupportProgramEvidenceMatch(
                            id=identity.id,
                            contentHash=identity.content_hash,
                            documentId=identity.document_id,
                            order=identity.order,
                            score=point.score,
                        )
                    )
                expected_count = min(request.limit, len(point_ids))
                if len(matches) != expected_count:
                    raise SupportProgramEvidenceError("EVIDENCE_NOT_READY")
                matches.sort(
                    key=lambda match: (
                        -match.score,
                        match.id,
                    )
                )
                result = SupportProgramEvidenceSearchResponse(question=request.question, matches=matches)
                finished_at = monotonic()
                outcome = "completed"
                logger.info(
                    "support_program_evidence_search_completed chunk_count=%d readiness_ms=%d embedding_ms=%d "
                    "vector_search_ms=%d elapsed_ms=%d cache_state=%s",
                    len(point_ids), round((ready_at - started_at) * 1000),
                    round((embedded_at - ready_at) * 1000), round((finished_at - embedded_at) * 1000),
                    round((finished_at - started_at) * 1000), cache_state,
                )
                return result
        except SupportProgramEvidenceError:
            raise
        except Exception as error:
            raise SupportProgramEvidenceError() from error
        finally:
            if outcome != "completed":
                logger.info(
                    "support_program_evidence_search_failed stage=%s elapsed_ms=%d",
                    stage, round((monotonic() - started_at) * 1000),
                )

    async def search_documents(
        self,
        question: str,
        documents: dict[str, list[tuple[str, str]]],
        per_document_limit: int,
    ) -> dict[str, list[SupportProgramEvidenceDocumentChunk]]:
        """여러 문서의 허용 청크 안에서 질문과 가까운 청크를 문서마다 최대 per_document_limit개 찾는다.

        색인되지 않았거나 원문이 없는 청크는 조용히 빠진다(호출부가 '원문 미확인'으로 다룬다). 청크 목록이 빈 문서는 검색하지 않는다.
        """
        if not 1 <= per_document_limit <= 10:
            raise ValueError("per_document_limit must be 1~10")
        identities: dict[str, tuple[str, str, str]] = {}
        for document_id, chunks in documents.items():
            for chunk_id, content_hash in chunks:
                identities[_point_id_of(chunk_id, content_hash)] = (chunk_id, content_hash, document_id)
        if not identities:
            return {}
        started_at = monotonic()
        try:
            async with asyncio.timeout(25):
                if not await self.qdrant_client.collection_exists(self.collection_name):
                    return {}
                indexed = await self.qdrant_client.retrieve(
                    collection_name=self.collection_name, ids=list(identities), with_payload=True, with_vectors=False,
                )
                present: dict[str, dict] = {}
                for point in indexed:
                    identity = identities.get(str(point.id))
                    payload = point.payload or {}
                    if identity is None or not isinstance(payload.get("text"), str) or (
                        payload.get("id"), payload.get("contentHash"), payload.get("documentId"),
                    ) != identity:
                        continue
                    present[str(point.id)] = payload
                if not present:
                    return {}
                vector, cache_state = await self._embed_query(question)
                response = await self.qdrant_client.query_points(
                    collection_name=self.collection_name,
                    query=vector,
                    query_filter=models.Filter(must=[models.HasIdCondition(has_id=list(present))]),
                    limit=min(per_document_limit * len(documents), len(present)),
                    with_payload=True,
                    with_vectors=False,
                )
                grouped: dict[str, list[SupportProgramEvidenceDocumentChunk]] = {}
                for point in response.points:
                    payload = present.get(str(point.id))
                    if payload is None:
                        continue
                    bucket = grouped.setdefault(payload["documentId"], [])
                    if len(bucket) >= per_document_limit:
                        continue
                    bucket.append(SupportProgramEvidenceDocumentChunk(
                        id=payload["id"], contentHash=payload["contentHash"], documentId=payload["documentId"],
                        order=int(payload.get("order", 0)), text=payload["text"], score=float(point.score),
                    ))
                logger.info(
                    "support_program_evidence_document_search_completed document_count=%d chunk_count=%d matched_documents=%d "
                    "elapsed_ms=%d cache_state=%s",
                    len(documents), len(identities), len(grouped), round((monotonic() - started_at) * 1000), cache_state,
                )
                return grouped
        except Exception as error:
            raise SupportProgramEvidenceError() from error

    async def _embed_query(self, query: str) -> tuple[list[float], str]:
        key = sha256(query.encode("utf-8")).hexdigest()
        lock, users = self._query_embedding_locks.get(key, (asyncio.Lock(), 0))
        self._query_embedding_locks[key] = (lock, users + 1)
        waited = lock.locked()
        try:
            # 다른 질문은 병렬 처리한다. 소유 요청 취소 시 다음 요청이 다시 임베딩한다.
            async with lock:
                cached = self._query_embedding_cache.get(key)
                if cached is not None:
                    expires_at, vector = cached
                    if expires_at > monotonic():
                        self._query_embedding_cache.move_to_end(key)
                        return list(vector), "coalesced" if waited else "hit"
                    del self._query_embedding_cache[key]
                vector = (await self._embed([query]))[0]
                now = monotonic()
                for cached_key, (expires_at, _) in list(self._query_embedding_cache.items()):
                    if expires_at <= now:
                        del self._query_embedding_cache[cached_key]
                self._query_embedding_cache[key] = (
                    now + _EMBEDDING_CACHE_TTL_SECONDS, tuple(vector),
                )
                while len(self._query_embedding_cache) > _QUERY_EMBEDDING_CACHE_MAX_SIZE:
                    self._query_embedding_cache.popitem(last=False)
                return list(vector), "miss"
        finally:
            _, users = self._query_embedding_locks[key]
            if users == 1:
                del self._query_embedding_locks[key]
            else:
                self._query_embedding_locks[key] = (lock, users - 1)

    async def _embed_chunks(self, texts: list[str]) -> tuple[list[list[float]], int]:
        # index_chunks의 쓰기 잠금 안에서만 호출한다. 청크 ID가 바뀌어도 같은 내용은 재사용한다.
        # 문서 ID·순서는 캐시 대상이 아니며 매번 Qdrant 검증과 별도 point 저장을 거친다.
        keys = [sha256(text.encode("utf-8")).hexdigest() for text in texts]
        now = monotonic()
        for key, (expires_at, _) in list(self._chunk_embedding_cache.items()):
            if expires_at <= now:
                del self._chunk_embedding_cache[key]
        vectors: dict[str, tuple[float, ...]] = {}
        missing: dict[str, str] = {}
        for key, text in zip(keys, texts, strict=True):
            cached = self._chunk_embedding_cache.get(key)
            if cached is None:
                missing[key] = text
            else:
                self._chunk_embedding_cache.move_to_end(key)
                vectors[key] = cached[1]
        cache_hits = sum(key in vectors for key in keys)
        if missing:
            embedded = await self._embed(list(missing.values()))
            expires_at = monotonic() + _EMBEDDING_CACHE_TTL_SECONDS
            # 전체 배치의 벡터 검증이 끝난 뒤에만 캐시한다. 원문은 캐시에 보관하지 않는다.
            for key, vector in zip(missing, embedded, strict=True):
                vectors[key] = tuple(vector)
                self._chunk_embedding_cache[key] = (expires_at, vectors[key])
            while len(self._chunk_embedding_cache) > _CHUNK_EMBEDDING_CACHE_MAX_SIZE:
                self._chunk_embedding_cache.popitem(last=False)
        return [list(vectors[key]) for key in keys], cache_hits

    async def _ensure_collection(self) -> None:
        if not await self.qdrant_client.collection_exists(self.collection_name):
            await self.qdrant_client.create_collection(
                collection_name=self.collection_name,
                vectors_config=models.VectorParams(
                    size=self.embedding_dimensions,
                    distance=models.Distance.COSINE,
                ),
            )
        collection = await self.qdrant_client.get_collection(self.collection_name)
        vector_config = collection.config.params.vectors
        if (
            not isinstance(vector_config, models.VectorParams)
            or vector_config.size != self.embedding_dimensions
            or vector_config.distance != models.Distance.COSINE
        ):
            raise SupportProgramEvidenceError()

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        inputs = await asyncio.to_thread(prepare_embedding_inputs, texts)
        vectors: list[list[float]] = []
        # 32 × 8191 < OpenAI 요청당 최대 300,000 tokens.
        for offset in range(0, len(inputs), 32):
            batch = inputs[offset : offset + 32]
            async with asyncio.timeout(self.embedding_timeout_seconds):
                raw_response = await self.openai_client.embeddings.with_raw_response.create(
                    model=self.embedding_model,
                    input=batch,
                    dimensions=self.embedding_dimensions,
                    encoding_format="float",
                    timeout=self.embedding_timeout_seconds,
                )
            response = raw_response.http_response.json()
            if (
                not isinstance(response, dict)
                or response.get("model") != self.embedding_model
            ):
                raise SupportProgramEvidenceError()
            data = response.get("data")
            if not isinstance(data, list) or len(data) != len(batch):
                raise SupportProgramEvidenceError()
            ordered: dict[int, list[float]] = {}
            for item in data:
                if not isinstance(item, dict):
                    raise SupportProgramEvidenceError()
                index = item.get("index")
                if (
                    type(index) is not int
                    or index not in range(len(batch))
                    or index in ordered
                ):
                    raise SupportProgramEvidenceError()
                vector = item.get("embedding")
                if (
                    not isinstance(vector, list)
                    or len(vector) != self.embedding_dimensions
                    or any(
                        isinstance(value, bool)
                        or not isinstance(value, (int, float))
                        or not isfinite(value)
                        for value in vector
                    )
                    or not any(value != 0 for value in vector)
                ):
                    raise SupportProgramEvidenceError()
                ordered[index] = vector
            vectors.extend(ordered[index] for index in range(len(batch)))
        return vectors


def _point_id(chunk: EvidenceChunkIdentity) -> str:
    return _point_id_of(chunk.id, chunk.content_hash)


def _point_id_of(chunk_id: str, content_hash: str) -> str:
    return str(uuid5(NAMESPACE_URL, f"govbiz:support-program-evidence:v1:{chunk_id}:{content_hash}"))


def _payload_matches(
    payload: dict | None,
    identity: EvidenceChunkIdentity,
) -> bool:
    return (
        payload is not None
        and payload.get("id") == identity.id
        and payload.get("contentHash") == identity.content_hash
        and payload.get("documentId") == identity.document_id
        and payload.get("order") == identity.order
    )
