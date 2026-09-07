# -*- coding: utf-8 -*-
"""ChromaDB 持久化向量存储（按角色隔离 collection）。"""

import re
from pathlib import Path
from typing import Any

import chromadb
from chromadb.config import Settings


def safe_collection_name(character_id: str) -> str:
    safe = re.sub(r"[^a-zA-Z0-9_-]", "_", str(character_id or "default"))
    return f"rp_memory_{safe}"


class MemoryStore:
    def __init__(self, persist_dir: str | Path):
        self.persist_dir = Path(persist_dir)
        self.persist_dir.mkdir(parents=True, exist_ok=True)
        self.client = chromadb.PersistentClient(
            path=str(self.persist_dir),
            settings=Settings(anonymized_telemetry=False),
        )

    def _collection(self, character_id: str):
        name = safe_collection_name(character_id)
        return self.client.get_or_create_collection(
            name=name,
            metadata={"hnsw:space": "cosine"},
        )

    def upsert_entries(self, character_id: str, entries: list[dict[str, Any]]) -> int:
        if not entries:
            return 0
        col = self._collection(character_id)
        ids = []
        documents = []
        metadatas = []
        embeddings = []
        for entry in entries:
            doc_id = str(entry["id"])
            content = str(entry.get("content") or "").strip()
            if not content:
                continue
            meta = entry.get("metadata") or {}
            meta = {k: (v if isinstance(v, (str, int, float, bool)) else str(v)) for k, v in meta.items()}
            ids.append(doc_id)
            documents.append(content)
            metadatas.append(meta)
            if entry.get("embedding") is not None:
                embeddings.append(entry["embedding"])
        if not ids:
            return 0
        kwargs = {"ids": ids, "documents": documents, "metadatas": metadatas}
        if embeddings and len(embeddings) == len(ids):
            kwargs["embeddings"] = embeddings
        col.upsert(**kwargs)
        return len(ids)

    def query(self, character_id: str, query_embedding: list[float], k: int = 4) -> list[dict]:
        col = self._collection(character_id)
        if col.count() == 0:
            return []

        # MMR: 先取候选池（top-20 或全部），再按多样性选 k 条
        fetch_n = min(max(k * 5, 20), col.count())
        result = col.query(
            query_embeddings=[query_embedding],
            n_results=fetch_n,
            include=["documents", "metadatas", "distances", "embeddings"],
        )

        candidates = []
        for i in range(len(result["ids"][0])):
            candidates.append({
                "id": result["ids"][0][i],
                "content": result["documents"][0][i],
                "metadata": result["metadatas"][0][i] or {},
                "distance": result["distances"][0][i],
                "embedding": result["embeddings"][0][i],
            })

        if len(candidates) <= k:
            return candidates

        # MMR 选择
        import numpy as np
        lambda_param = 0.5
        query_emb = np.array(query_embedding)

        selected = [candidates[0]]  # 选相关度最高的
        remaining = list(range(1, len(candidates)))

        while len(selected) < k and remaining:
            best_score = -1.0
            best_idx = remaining[0]
            for idx in remaining:
                # relevance: 1 - cosine_distance
                relevance = 1.0 - candidates[idx]["distance"]
                # max similarity to already selected
                max_sim = 0.0
                for sel in selected:
                    sim = float(np.dot(candidates[idx]["embedding"], sel["embedding"]))
                    if sim > max_sim:
                        max_sim = sim
                mmr_score = lambda_param * relevance - (1.0 - lambda_param) * max_sim
                if mmr_score > best_score:
                    best_score = mmr_score
                    best_idx = idx
            selected.append(candidates[best_idx])
            remaining.remove(best_idx)

        # 清理 embedding 字段（不需要返回给调用方）
        for s in selected:
            s.pop("embedding", None)
        return selected

    def delete_character(self, character_id: str) -> bool:
        name = safe_collection_name(character_id)
        try:
            self.client.delete_collection(name)
            return True
        except Exception:
            return False
