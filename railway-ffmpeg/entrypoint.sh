#!/bin/sh
# Entrypoint do railway-ffmpeg.
#
# Se BGUTIL_POT_BASE_URL estiver definida (URL interna do serviço PO Token
# provider no Railway), injeta o extractor-arg no config global do yt-dlp pra
# TODAS as chamadas usarem PO tokens — derruba o "Sign in to confirm you're
# not a bot" sem depender de cookies que expiram.
#
# Degradacao graciosa: se a env nao existir (provider ainda nao criado), o
# yt-dlp roda exatamente como antes. Nada quebra.

set -e

if [ -n "$BGUTIL_POT_BASE_URL" ]; then
  mkdir -p /root/.config/yt-dlp
  # --plugin-dirs: o yt-dlp standalone NAO escaneia ~/.config/yt-dlp/plugins
  # automaticamente (debug mostrava "Plugin directories: none"). Apontar
  # explicito pro dir que contem o pacote yt_dlp_plugins faz o provider carregar.
  {
    echo "--plugin-dirs /root/.config/yt-dlp/plugins"
    echo "--extractor-args \"youtubepot-bgutilhttp:base_url=$BGUTIL_POT_BASE_URL\""
  } > /root/.config/yt-dlp/config
  echo "[entrypoint] PO Token provider configurado: $BGUTIL_POT_BASE_URL"
else
  echo "[entrypoint] BGUTIL_POT_BASE_URL nao definida — yt-dlp sem PO token (comportamento atual)"
fi

exec node server.js
