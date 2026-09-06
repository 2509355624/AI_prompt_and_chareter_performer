# -*- coding: utf-8 -*-
"""
RAG 常驻进程：保持 BGE-M3 加载，通过 stdin/stdout JSON Lines 通信。

请求: {"id":"1","cmd":"retrieve|ingest|delete_character|ping", ...}
响应: {"id":"1","ok":true,...} 或 {"id":"1","ok":false,"error":"..."}
"""

import json
import os
import sys
import traceback
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).parent
ROOT = HERE.parent
load_dotenv(ROOT / ".env")

from local_embeddings import LocalEmbeddings, DEFAULT_MODEL  # noqa: E402
from store import MemoryStore  # noqa: E402


def _reply(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _resolve_data_dir() -> Path:
    """统一落到项目根 data/rag；相对路径相对 ROOT 解析，避免 cwd=rag/ 时偏到 rag/data/rag。"""
    raw = os.environ.get("RAG_DATA_DIR", "").strip()
    if not raw:
        return ROOT / "data" / "rag"
    p = Path(raw)
    if not p.is_absolute():
        p = (ROOT / p).resolve()
    return p


def _load_services():
    data_dir = _resolve_data_dir()
    chroma_dir = data_dir / "chroma"
    print(f"[RAG] data_dir={data_dir}", file=sys.stderr, flush=True)
    device = os.environ.get("RAG_EMBED_DEVICE", "cuda").strip().lower()
    model_name = os.environ.get("LOCAL_EMBEDDING_MODEL", DEFAULT_MODEL)
    embeddings = LocalEmbeddings(model_name=model_name, device=device)
    store = MemoryStore(chroma_dir)
    return embeddings, store


def _handle(req: dict, embeddings: LocalEmbeddings, store: MemoryStore) -> dict:
    req_id = req.get("id")
    cmd = req.get("cmd")
    try:
        if cmd == "ping":
            return {"id": req_id, "ok": True, "ready": True}

        if cmd == "retrieve":
            character_id = str(req.get("characterId") or "").strip()
            query = str(req.get("query") or "").strip()
            k = int(req.get("k") or os.environ.get("RAG_RETRIEVE_K", "4"))
            if not character_id or not query:
                raise ValueError("characterId and query are required")
            q_vec = embeddings.embed_query(query)
            docs = store.query(character_id, q_vec, k=k)
            return {"id": req_id, "ok": True, "docs": docs}

        if cmd == "ingest":
            character_id = str(req.get("characterId") or "").strip()
            entries = req.get("entries") or []
            if not character_id:
                raise ValueError("characterId is required")
            prepared = []
            texts = []
            for entry in entries:
                content = str(entry.get("content") or "").strip()
                if not content:
                    continue
                texts.append(content)
                prepared.append(entry)
            if not texts:
                return {"id": req_id, "ok": True, "count": 0}
            vectors = embeddings.embed_documents(texts)
            upsert_rows = []
            for entry, vec in zip(prepared, vectors):
                upsert_rows.append({
                    "id": entry["id"],
                    "content": entry["content"],
                    "metadata": entry.get("metadata") or {},
                    "embedding": vec,
                })
            count = store.upsert_entries(character_id, upsert_rows)
            return {"id": req_id, "ok": True, "count": count}

        if cmd == "delete_character":
            character_id = str(req.get("characterId") or "").strip()
            if not character_id:
                raise ValueError("characterId is required")
            deleted = store.delete_character(character_id)
            return {"id": req_id, "ok": True, "deleted": deleted}

        raise ValueError(f"unknown cmd: {cmd}")
    except Exception as exc:
        return {"id": req_id, "ok": False, "error": str(exc)}


def main():
    embeddings, store = _load_services()
    _reply({"id": "0", "ok": True, "event": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _reply({"id": None, "ok": False, "error": f"invalid json: {exc}"})
            continue
        resp = _handle(req, embeddings, store)
        _reply(resp)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
