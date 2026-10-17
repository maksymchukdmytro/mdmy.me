"""Локальна розшифровка аудіо через faster-whisper.

Модель завантажується один раз при першому виклику і далі живе в пам'яті.
Декодування аудіо робить сам faster-whisper (через PyAV), тому окремо
ffmpeg не потрібен: webm/opus з браузера, ogg з Telegram, mp3, m4a, wav
приймаються як є.

Налаштування через змінні середовища:
  WHISPER_MODEL     tiny | base | small | medium | large-v3-turbo   (за замовч. large-v3-turbo)
  WHISPER_DEVICE    cpu | cuda                                (за замовч. cpu)
  WHISPER_COMPUTE   int8 | float16 | float32                  (за замовч. int8)
  WHISPER_LANGUAGE  uk | en | ... | auto                      (за замовч. uk)
"""

from __future__ import annotations

import io
import os
import threading
import time
from dataclasses import dataclass

from faster_whisper import WhisperModel

MODEL_NAME = os.getenv("WHISPER_MODEL", "large-v3-turbo")
DEVICE = os.getenv("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE", "int8")
_lang = os.getenv("WHISPER_LANGUAGE", "uk").strip().lower()
LANGUAGE: str | None = None if _lang in ("", "auto") else _lang
# Підказка-контекст: зразок грамотного українського тексту з пунктуацією. Whisper підлаштовує
# під нього правопис, розділові знаки й лексику. Порожній WHISPER_PROMPT вимикає підказку.
PROMPT = os.getenv(
    "WHISPER_PROMPT",
    "Привіт! Це запис українською мовою: думки, нотатки, плани й завдання на день. "
    "Говорю про роботу, навчання, сайт, програмування та штучний інтелект.",
).strip() or None

_model: WhisperModel | None = None
_model_lock = threading.Lock()
# На CPU паралельні розшифровки лише заважають одна одній, тому по черзі.
_run_lock = threading.Lock()


@dataclass
class Transcript:
    text: str
    language: str
    duration: float      # тривалість аудіо, с
    elapsed: float       # скільки йшла розшифровка, с


def get_model() -> WhisperModel:
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                print(f"[whisper] завантажую модель '{MODEL_NAME}' ({DEVICE}, {COMPUTE_TYPE})...")
                _model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)
                print("[whisper] модель готова")
    return _model


RU_PROMPT = (
    "Привет! Это запись на русском языке: мысли, заметки, планы и задачи на день. "
    "Говорю о работе, учёбе, сайте, программировании и искусственном интеллекте."
)
LANGUAGES = {"uk", "ru", "en", "auto"}
_DEFAULT = object()


def transcribe(audio: bytes | str, language: str | None | object = _DEFAULT) -> Transcript:
    """Приймає байти аудіофайлу або шлях до нього, повертає текст.

    language: "uk" / "ru" / "en" — мова зафіксована; "auto" або None — модель визначає
    мову сама для кожного фрагмента (для мішаного мовлення). Без аргументу — WHISPER_LANGUAGE.
    """
    if language is _DEFAULT:
        language = LANGUAGE
    if language == "auto":
        language = None
    # Підказку-контекст даємо лише для зафіксованої мови: в авторежимі вона тягнула б
    # визначення мови в бік мови підказки.
    prompt = {"uk": PROMPT, "ru": RU_PROMPT}.get(language)
    source = io.BytesIO(audio) if isinstance(audio, (bytes, bytearray)) else audio
    model = get_model()
    started = time.perf_counter()
    with _run_lock:
        segments, info = model.transcribe(
            source,
            language=language,
            multilingual=language is None,  # авто: мова визначається для кожного фрагмента
            beam_size=5,
            vad_filter=True,  # вирізає тишу на початку/в кінці й між фразами
            initial_prompt=prompt,
            # не тягнути помилки з попереднього фрагмента в наступний (менше «зациклень» на довгих записах)
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()
    return Transcript(
        text=text,
        language=info.language,
        duration=round(info.duration, 1),
        elapsed=round(time.perf_counter() - started, 1),
    )


if __name__ == "__main__":
    import sys

    if len(sys.argv) != 2:
        print("Використання: python transcriber.py шлях/до/аудіо")
        raise SystemExit(1)
    result = transcribe(sys.argv[1])
    print(f"[{result.language}, {result.duration} с аудіо, {result.elapsed} с обробки]")
    print(result.text)
