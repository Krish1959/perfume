# ---------- base ----------
FROM python:3.11-slim

# System packages we actually use
# - ffmpeg: for audio conversion in /api/voicechat
# - curl: handy for debugging
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg curl \
 && rm -rf /var/lib/apt/lists/*

# ---------- python env ----------
WORKDIR /app

# Install only backend deps first (better layer caching)
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Copy backend code
COPY backend /app/backend

# Copy frontend so backend can serve /frontend assets
COPY frontend /app/frontend

# Render will provide PORT, bind to it
ENV PORT=8000
CMD uvicorn backend.main:app --host 0.0.0.0 --port $PORT --workers 1
