FROM node:20-alpine

# FFmpeg + fontes para legendas
RUN apk add --no-cache \
  ffmpeg \
  fontconfig \
  ttf-dejavu \
  ttf-liberation \
  && rm -rf /var/cache/apk/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
