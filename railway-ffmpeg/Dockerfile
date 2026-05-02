FROM node:20-alpine

# FFmpeg + fontconfig + fontes do sistema + curl/unzip + python3 pro yt-dlp
RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  ttf-dejavu \
  ttf-liberation \
  curl \
  unzip \
  python3 \
  py3-brotli \
  py3-certifi \
  py3-requests \
  py3-websockets \
  && rm -rf /var/cache/apk/*

# yt-dlp binary standalone (Python script auto-contido).
# YTDLP_BUILD_DATE invalida o cache da camada Docker quando precisar forcar
# re-download (YouTube atualiza anti-bot e yt-dlp libera fix em horas).
# Pra forcar update: incremente a data abaixo + commit.
ARG YTDLP_BUILD_DATE=2026-05-02
RUN echo "yt-dlp build date: ${YTDLP_BUILD_DATE}" \
  && curl -fsSL -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

# Baixa fontes reais que o BlueEditor usa nos estilos (Bebas Neue + Oswald + Anton)
# Google Fonts serve direto sem auth. Instalamos em /usr/share/fonts/truetype/bt/
RUN mkdir -p /usr/share/fonts/truetype/bt && cd /tmp \
  && curl -fsSL -o bebas.zip "https://fonts.google.com/download?family=Bebas%20Neue" \
  && unzip -o bebas.zip -d bebas && cp bebas/*.ttf /usr/share/fonts/truetype/bt/ 2>/dev/null || true \
  && curl -fsSL -o oswald.zip "https://fonts.google.com/download?family=Oswald" \
  && unzip -o oswald.zip -d oswald && cp oswald/static/*.ttf /usr/share/fonts/truetype/bt/ 2>/dev/null || true \
  && curl -fsSL -o anton.zip "https://fonts.google.com/download?family=Anton" \
  && unzip -o anton.zip -d anton && cp anton/*.ttf /usr/share/fonts/truetype/bt/ 2>/dev/null || true \
  && fc-cache -fv \
  && rm -rf /tmp/bebas* /tmp/oswald* /tmp/anton*

# Verifica se as fontes foram instaladas (não falha o build se alguma faltar)
RUN fc-list | grep -iE "bebas|oswald|anton|liberation|dejavu" || true

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
