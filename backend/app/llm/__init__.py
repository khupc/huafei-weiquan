import os

from .base import Extraction, LLMProvider
from .stub import StubProvider


def get_provider() -> LLMProvider:
    name = os.getenv("LLM_PROVIDER", "stub")
    if name == "stub":
        return StubProvider()
    raise ValueError(f"Unknown LLM_PROVIDER={name!r}; only 'stub' is implemented so far")


__all__ = ["Extraction", "LLMProvider", "get_provider"]
