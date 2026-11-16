# getvid server: yt-dlp backend for the getvid site.
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt getvid_server.py ./
RUN pip install --no-cache-dir -U -r requirements.txt
ENV PORT=9100
EXPOSE 9100
# Update yt-dlp on every start: sites (YouTube especially) change often.
CMD ["sh", "-c", "pip install --no-cache-dir -q -U 'yt-dlp[default,curl-cffi]' || true; exec python getvid_server.py"]
