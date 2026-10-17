"""Сервіс розшифровки голосу для персонального асистента mdmy.me (/assistant і Telegram).

Слухає лише 127.0.0.1:8010; запити до нього надсилає Node-сервер сайту
(lib/stt.js) після перевірки входу. Тіло запиту — сирі
байти аудіо (webm/ogg/m4a/wav), відповідь — JSON з текстом.
Запуск на сервері — служба dm-stt (deploy/stt.sh).
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

import transcriber

MAX_BYTES = 25 * 1024 * 1024


@asynccontextmanager
async def lifespan(_: FastAPI):
    transcriber.get_model()  # завантажуємо модель одразу, а не на першому записі
    yield


app = FastAPI(title="mdmy.me STT", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": transcriber.MODEL_NAME, "language": transcriber.LANGUAGE or "auto"}


@app.post("/transcribe")
async def transcribe(request: Request, lang: str = "") -> dict:
    """lang: uk | ru | en | auto (порожньо — мова за замовчуванням служби)."""
    data = await request.body()
    if not data:
        raise HTTPException(400, "Порожній запис.")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "Запис завеликий.")
    if lang and lang not in transcriber.LANGUAGES:
        raise HTTPException(400, "Невідома мова.")
    try:
        if lang:
            result = await run_in_threadpool(transcriber.transcribe, data, lang)
        else:
            result = await run_in_threadpool(transcriber.transcribe, data)
    except Exception as exc:
        raise HTTPException(422, f"Не вдалося розпізнати аудіо ({type(exc).__name__}).") from exc
    return {"text": result.text, "language": result.language, "duration": result.duration, "elapsed": result.elapsed}
