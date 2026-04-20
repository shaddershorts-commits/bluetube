# .well-known — assetlinks.json

Este diretório contém o `assetlinks.json` exigido pelo Android para associar
o domínio `bluetubeviral.com` ao APK `com.bluetube.app`. Sem isso, o Android
mostra um picker "abrir com: BlueTube ou Navegador" ao clicar em links
`https://bluetubeviral.com/blue/*` — em vez de abrir direto no app.

## Como completar (uma vez por keystore)

1. Rodar no terminal, **dentro** do repo `bluetube-app`:
   ```bash
   cd C:/Users/felip/bluetube-app
   eas credentials --platform android
   ```
2. Na UI interativa:
   - Escolher profile `preview` (ou `production`)
   - Select existing keystore → **View keystore**
3. Copiar o valor de **SHA-256 Fingerprint**
   (formato `AA:BB:CC:DD:...` com 32 pares hex)
4. Substituir a string `REPLACE_WITH_SHA256_FROM_EAS_CREDENTIALS` no
   `assetlinks.json` pelo valor real (manter as aspas e as maiúsculas
   com `:` entre pares, ex: `"AB:CD:EF:..."`)
5. Commit + push → Vercel deploya automático
6. Testar: clicar num link tipo `https://bluetubeviral.com/blue/@shorts`
   no navegador do celular Android — deve abrir direto no app sem picker

## Verificar se está correto

```bash
curl https://bluetubeviral.com/.well-known/assetlinks.json
```

E usar a ferramenta oficial do Google:
https://developers.google.com/digital-asset-links/tools/generator

## Notas

- O keystore EAS é **único por projeto** — mesmo SHA serve pra preview e
  production (a menos que você crie keystores diferentes)
- Se gerar APK via Play Store App Signing, o SHA muda — nesse caso pegar o
  "App signing key certificate" no Play Console
