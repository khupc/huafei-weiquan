import os

from .base import Analysis, DemandOption, Extraction, LLMProvider
from .stub import StubProvider


def get_provider() -> LLMProvider:
    name = os.getenv("LLM_PROVIDER", "stub")
    if name == "stub":
        return StubProvider()
    if name == "openai":
        from .openai_compat import OpenAICompatProvider
        return OpenAICompatProvider()
    raise ValueError(f"Unknown LLM_PROVIDER={name!r}; use 'stub' or 'openai'")


__all__ = ["Analysis", "DemandOption", "Extraction", "LLMProvider", "get_provider"]
