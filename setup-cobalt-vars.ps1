$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\Users\felip\bluetube'

Write-Host '== 1/3 Carregando JSON dos cookies ==' -ForegroundColor Cyan
$jsonPath = 'C:\Users\felip\bluetube\cobalt-cookies.json'
if (-not (Test-Path -LiteralPath $jsonPath)) {
    throw "Arquivo nao encontrado: $jsonPath"
}
$j = [System.IO.File]::ReadAllText($jsonPath)
Write-Host "JSON carregado: $($j.Length) bytes" -ForegroundColor Green

Write-Host ''
Write-Host '== 2/3 Setando COBALT_COOKIES_JSON via stdin ==' -ForegroundColor Cyan
$j | & railway variable set COBALT_COOKIES_JSON --stdin --skip-deploys
if ($LASTEXITCODE -ne 0) { throw "railway set COBALT_COOKIES_JSON falhou (exit $LASTEXITCODE)" }

Write-Host ''
Write-Host '== 3/3 Setando COOKIE_PATH ==' -ForegroundColor Cyan
& railway variable set 'COOKIE_PATH=/tmp/cobalt-cookies.json' --skip-deploys
if ($LASTEXITCODE -ne 0) { throw "railway set COOKIE_PATH falhou (exit $LASTEXITCODE)" }

Write-Host ''
Write-Host '== Verificando ==' -ForegroundColor Cyan
$listOutput = & railway variable list --kv
$cookieLine = $listOutput | Select-String -Pattern '^COBALT_COOKIES_JSON='
$pathLine   = $listOutput | Select-String -Pattern '^COOKIE_PATH='

if ($cookieLine) {
    $cookieLen = $cookieLine.Line.Length
    Write-Host "COBALT_COOKIES_JSON line length: $cookieLen (esperado ~3084)" -ForegroundColor Green
} else {
    Write-Host 'COBALT_COOKIES_JSON nao encontrada na lista!' -ForegroundColor Red
}

if ($pathLine) {
    Write-Host "COOKIE_PATH: $($pathLine.Line)" -ForegroundColor Green
} else {
    Write-Host 'COOKIE_PATH nao encontrada na lista!' -ForegroundColor Red
}

Write-Host ''
Write-Host 'PRONTO. Manda print desta tela.' -ForegroundColor Yellow
