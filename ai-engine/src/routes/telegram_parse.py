"""Telegram signal parse API route.

``POST /api/telegram/parse`` — turns a free-text Telegram message into the
structured signal contract (see ``telegram_parser_service``).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from ..services.telegram_parser_service import parse_signal

router = APIRouter()


class ParseRequest(BaseModel):
    text: str = Field(..., min_length=1)


@router.post("/telegram/parse")
async def telegram_parse_endpoint(req: ParseRequest):
    try:
        return await parse_signal(req.text)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=str(exc))
