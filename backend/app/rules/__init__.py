"""Config-driven rule library (spec 2.1 / 4.3). Edit the YAML files, not code."""
from functools import lru_cache
from pathlib import Path

import yaml

_DIR = Path(__file__).parent


@lru_cache
def _load(name: str) -> dict:
    return yaml.safe_load((_DIR / f"{name}.yaml").read_text(encoding="utf-8"))


def carriers() -> dict:
    return _load("carriers")["carriers"]


def provinces() -> list[str]:
    return _load("carriers")["provinces"]


def categories() -> dict:
    return _load("categories")["categories"]


def templates() -> dict:
    return _load("templates")
