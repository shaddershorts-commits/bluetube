FROM node:20-alpine

# FFmpeg + fontconfig + fontes do sistema + curl/unzip pra baixar fontes extras
RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  ttf-dejavu \
  ttf-liberation \
  curl \
  unzip \
  && rm -rf /var/cache/apk/*

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
