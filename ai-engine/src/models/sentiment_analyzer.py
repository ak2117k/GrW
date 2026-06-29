"""
News sentiment analysis model for the TD Automation AI Engine.
Uses rule-based keyword matching and scoring for the initial phase.
"""

import re
import logging
from typing import Dict, List, Any

logger = logging.getLogger(__name__)

# Keyword lists with associated weights
BULLISH_KEYWORDS = [
    ("beat estimates", 1.0),
    ("rally", 0.8),
    ("surge", 0.9),
    ("positive", 0.6),
    ("upgrade", 0.7),
    ("bullish", 0.9),
    ("growth", 0.5),
    ("profit", 0.6),
    ("outperform", 0.7),
    ("recovery", 0.6),
    ("breakout", 0.7),
    ("all-time high", 0.9),
    ("strong results", 0.7),
    ("buy", 0.5),
    ("optimistic", 0.6),
    ("upbeat", 0.6),
    ("expansion", 0.5),
    ("dividend", 0.4),
    ("record high", 0.8),
    ("rate cut", 0.6),
    ("unchanged", 0.3),
]

BEARISH_KEYWORDS = [
    ("miss estimates", 1.0),
    ("crash", 0.9),
    ("fall", 0.5),
    ("negative", 0.6),
    ("downgrade", 0.7),
    ("bearish", 0.9),
    ("loss", 0.6),
    ("default", 0.8),
    ("sell", 0.5),
    ("underperform", 0.7),
    ("correction", 0.6),
    ("slump", 0.8),
    ("weak results", 0.7),
    ("rate hike", 0.5),
    ("recession", 0.8),
    ("inflation", 0.4),
    ("crisis", 0.8),
    ("decline", 0.6),
    ("layoff", 0.5),
    ("fraud", 0.9),
    ("scam", 0.9),
]

# Known entities for simple NER
SECTOR_NAMES = [
    "banking", "pharma", "IT", "auto", "FMCG", "metal", "energy",
    "realty", "infrastructure", "telecom", "media", "finance",
    "insurance", "healthcare", "technology", "cement", "chemical",
]

INSTITUTION_NAMES = [
    "RBI", "SEBI", "NSE", "BSE", "FII", "DII", "MPC",
    "Fed", "ECB", "IMF", "World Bank",
]

MAJOR_COMPANIES = [
    "Reliance", "TCS", "Infosys", "HDFC", "ICICI", "SBI",
    "Wipro", "HUL", "ITC", "Bajaj", "Kotak", "Adani",
    "Tata", "Airtel", "Maruti", "L&T", "Axis",
]


def _extract_entities(text: str) -> List[str]:
    """Extract entity names from text using simple pattern matching.

    Args:
        text: Input text to scan for entities.

    Returns:
        List of detected entity names.
    """
    entities = []
    text_lower = text.lower()

    for sector in SECTOR_NAMES:
        if sector.lower() in text_lower:
            entities.append(sector.lower())

    for inst in INSTITUTION_NAMES:
        # Case-sensitive match for acronyms
        if inst in text:
            entities.append(inst)

    for company in MAJOR_COMPANIES:
        if company.lower() in text_lower:
            entities.append(company)

    # Deduplicate while preserving order
    seen = set()
    unique = []
    for e in entities:
        key = e.lower()
        if key not in seen:
            seen.add(key)
            unique.append(e)

    return unique


def analyze_sentiment(text: str) -> Dict[str, Any]:
    """Analyze the sentiment of a news text using rule-based keyword matching.

    Scans for bullish and bearish keywords, weights their impact, and produces
    a composite score from -1.0 (very bearish) to +1.0 (very bullish).

    Args:
        text: The news text to analyze.

    Returns:
        Dict with:
            - sentiment: 'bullish', 'bearish', or 'neutral'
            - score: float from -1.0 to 1.0
            - entities: list of detected entity names
            - summary: brief summary of the sentiment signal
    """
    if not text or not text.strip():
        return {
            "sentiment": "neutral",
            "score": 0.0,
            "entities": [],
            "summary": "No text provided for analysis.",
        }

    text_lower = text.lower()

    bullish_total = 0.0
    bullish_count = 0
    for keyword, weight in BULLISH_KEYWORDS:
        if keyword.lower() in text_lower:
            bullish_total += weight
            bullish_count += 1

    bearish_total = 0.0
    bearish_count = 0
    for keyword, weight in BEARISH_KEYWORDS:
        if keyword.lower() in text_lower:
            bearish_total += weight
            bearish_count += 1

    # Compute raw score
    total_weight = bullish_total + bearish_total
    if total_weight == 0:
        raw_score = 0.0
    else:
        raw_score = (bullish_total - bearish_total) / total_weight

    # Clamp to [-1.0, 1.0]
    score = max(-1.0, min(1.0, raw_score))

    # Classify sentiment
    if score > 0.15:
        sentiment = "bullish"
    elif score < -0.15:
        sentiment = "bearish"
    else:
        sentiment = "neutral"

    entities = _extract_entities(text)

    # Generate summary
    if sentiment == "bullish":
        if bullish_count >= 3:
            summary = "Strongly positive signal with multiple bullish indicators."
        else:
            summary = "Positive monetary policy signal" if any(
                inst in text for inst in ["RBI", "Fed", "rate"]
            ) else "Positive market signal detected."
    elif sentiment == "bearish":
        if bearish_count >= 3:
            summary = "Strongly negative signal with multiple bearish indicators."
        else:
            summary = "Negative market signal detected."
    else:
        summary = "Mixed or neutral sentiment — no clear directional bias."

    logger.info(
        "Sentiment analyzed: score=%.2f sentiment=%s entities=%s",
        score, sentiment, entities,
    )

    return {
        "sentiment": sentiment,
        "score": round(score, 2),
        "entities": entities,
        "summary": summary,
    }
