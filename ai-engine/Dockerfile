FROM python:3.12-slim
WORKDIR /app
COPY requirements-scorer.txt .
RUN pip install --no-cache-dir -r requirements-scorer.txt
COPY src ./src
ENV PYTHONUNBUFFERED=1 MODELS_DIR=/models
EXPOSE 5000
# Minimal app: only /score, /corpus/similar and /health (never imports src/main.py and its heavy routers).
CMD ["uvicorn", "src.scorer_main:app", "--host", "0.0.0.0", "--port", "5000", "--workers", "1"]
