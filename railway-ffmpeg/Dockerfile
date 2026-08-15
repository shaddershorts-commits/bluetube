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
# USA NIGHTLY BUILDS — release diário com fixes mais frescos pra anti-bot
# do YouTube. Stable (releases/latest) fica meses sem release às vezes
# (ex: 2026-03-17 → 2026-05-14 = nada novo), mas YouTube muda anti-bot
# toda semana. Nightly cobre vídeos recém-uploadados que o stable falha.
# YTDLP_BUILD_DATE invalida o cache da camada Docker quando precisar forcar
# re-download. Pra forcar update: incremente a data abaixo + commit.
ARG YTDLP_BUILD_DATE=2026-05-14
RUN echo "yt-dlp build date: ${YTDLP_BUILD_DATE}" \
  && curl -fsSL -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp \
  && chmod +x /usr/local/bin/yt-dlp \
  && yt-dlp --version

# Plugin PO Token (bgutil) pro yt-dlp standalone. Gera proof-of-origin token
# que derruba o "Sign in to confirm you're not a bot" SEM depender de cookies
# que expiram. O provider que gera os tokens roda como SERVICO SEPARADO no
# Railway (imagem oficial brainicism/bgutil-ytdlp-pot-provider) — aqui so
# instalamos o plugin que fala com ele. URL do provider vem via env
# BGUTIL_POT_BASE_URL (injetada no config pelo entrypoint.sh).
# Se o download do plugin falhar, o build falha e o Railway mantem o deploy
# anterior no ar (sem downtime).
RUN mkdir -p /root/.config/yt-dlp/plugins \
  && curl -fsSL -o /tmp/bgutil-plugin.zip \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/latest/download/bgutil-ytdlp-pot-provider.zip \
  && unzip -o /tmp/bgutil-plugin.zip -d /root/.config/yt-dlp/plugins/ \
  && rm /tmp/bgutil-plugin.zip \
  && (yt-dlp -v 2>&1 | grep -iE "plugin|bgutil|pot" | head -5 || true)

# Fontes que o BlueEditor usa nos estilos (Anton + Bebas Neue + Oswald).
# ⚠️ FONTE CONFIÁVEL (15/08/2026): o endpoint fonts.google.com/download MORREU
# (devolve a página HTML) e o `|| true` engolia — um rebuild sem cache subia
# SEM NENHUMA fonte em silêncio (a "fonte trocada" do teste real do dono).
# Agora: TTFs direto do repositório oficial google/fonts no GitHub, SEM
# engolir erro, e com verificação que DERRUBA o build se qualquer uma faltar.
# Oswald é o arquivo VARIÁVEL — instância padrão = Regular 400, igual ao
# preview (o Oswald-Bold antigo era a outra metade da "fonte diferente").
RUN mkdir -p /usr/share/fonts/truetype/bt && cd /usr/share/fonts/truetype/bt \
  && curl -fsSL -o Anton-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/anton/Anton-Regular.ttf" \
  && curl -fsSL -o BebasNeue-Regular.ttf "https://github.com/google/fonts/raw/main/ofl/bebasneue/BebasNeue-Regular.ttf" \
  && curl -fsSL -o Oswald.ttf "https://github.com/google/fonts/raw/main/ofl/oswald/Oswald%5Bwght%5D.ttf" \
  && fc-cache -fv

# Verificação DURA: build quebra na cara se qualquer fonte não for TTF real
RUN set -e; for f in Anton-Regular.ttf BebasNeue-Regular.ttf Oswald.ttf; do \
      test -s "/usr/share/fonts/truetype/bt/$f" || { echo "FONTE FALTANDO: $f"; exit 1; }; \
      head -c 4 "/usr/share/fonts/truetype/bt/$f" | od -An -tx1 | grep -q "00 01 00 00" \
        || { echo "FONTE INVÁLIDA (não é TTF): $f"; exit 1; }; \
    done; fc-list | grep -iE "anton|bebas|oswald"

# Compat glibc pro onnxruntime-node (detector de texto PRÓPRIO da BlueClean).
# Se falhar em runtime, o server.js cai no fallback (detector externo) sem quebrar.
RUN apk add --no-cache gcompat libstdc++

WORKDIR /app

# Modelo DBNet PP-OCRv4 (detecção de texto, 4.7MB) — RapidOCR ONNX oficial.
# Falha no download = build falha = deploy anterior continua no ar.
RUN curl -fsSL -o /app/det.onnx \
  https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx \
  && ls -la /app/det.onnx

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
# BaixaTudo: modulo isolado montado pelo server.js. Sem esta linha o require
# falha dentro do try/catch e a rota some em silencio (404).
COPY baixatudo.js ./
COPY entrypoint.sh ./
# Strip CR (caso o arquivo tenha sido salvo com CRLF no Windows) + exec bit
RUN sed -i 's/\r$//' entrypoint.sh && chmod +x entrypoint.sh

ENV PORT=3000
EXPOSE 3000

CMD ["sh", "/app/entrypoint.sh"]
