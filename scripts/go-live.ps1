# go-live.ps1: bring the Periscope live server back in one command (Windows).
# 1) loads .env  2) starts the API on 4747 in its own window  3) opens a Cloudflare quick tunnel
# 4) checks the API through the tunnel  5) prints the public address to paste into the site.
#
# Put this file in periscope\scripts\ and run from CMD in the repo folder:
#   powershell -ExecutionPolicy Bypass -File scripts\go-live.ps1
# Two windows open (API, tunnel). Close them to stop.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)   # repo root

function Say($m)  { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Stop-Now($m) { Write-Host ""; Write-Host "STOP: $m" -ForegroundColor Red; exit 1 }
function Health($base) {
    try { return (Invoke-RestMethod -Uri "$base/health" -TimeoutSec 5) } catch { return $null }
}

# ---- 1. Keys ------------------------------------------------------------
# npm run api does NOT read .env by itself. Without STEEL_API_KEY it starts
# "read-only" and every Run button fails. Load it here.
if (-not (Test-Path ".env")) { Stop-Now "No .env file. Run:  copy env.template .env   then add STEEL_API_KEY." }
Get-Content ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#") -or -not $line.Contains("=")) { return }
    $k, $v = $line -split "=", 2
    $v = $v.Trim().Trim('"').Trim("'")
    if ($v -ne "") { Set-Item -Path "Env:$($k.Trim())" -Value $v }
}
if (-not $env:STEEL_API_KEY) { Stop-Now "STEEL_API_KEY is empty in .env. Add it and run again." }

$port  = if ($env:PERISCOPE_API_PORT) { $env:PERISCOPE_API_PORT } else { "4747" }
$local = "http://localhost:$port"
$data  = if ($env:PERISCOPE_DATA_DIR) { $env:PERISCOPE_DATA_DIR } else { ".\data" }
New-Item -ItemType Directory -Force -Path $data | Out-Null
$tunLog = Join-Path (Resolve-Path $data) "tunnel.log"

# ---- 2. API -------------------------------------------------------------
if (Health $local) {
    Say "API already running on $local. Using it."
} else {
    if (-not (Test-Path "node_modules")) { Say "Installing packages (first time only)..."; cmd /c "npm install"; if ($LASTEXITCODE -ne 0) { Stop-Now "npm install failed." } }
    Say "Starting API on $local (new window)..."
    Start-Process cmd -ArgumentList '/k title Periscope API && npm run api'
    $ok = $false
    for ($i = 0; $i -lt 60; $i++) { if (Health $local) { $ok = $true; break }; Start-Sleep 1 }
    if (-not $ok) { Stop-Now "API did not answer in 60s. Read the error in the 'Periscope API' window." }
}
$h = Health $local
Write-Host ("health: " + ($h | ConvertTo-Json -Compress))
if (-not $h.steel) { Stop-Now "API is up but Steel is OFF. Check STEEL_API_KEY in .env, then close the API window and run again." }

# ---- 3. Tunnel ----------------------------------------------------------
Say "Opening Cloudflare tunnel (new window)..."
if (Test-Path $tunLog) { Remove-Item $tunLog -Force }
$tunCmd = if (Get-Command cloudflared -ErrorAction SilentlyContinue) { "cloudflared" } else { "npx --yes cloudflared" }
Start-Process cmd -ArgumentList "/k title Periscope Tunnel && $tunCmd tunnel --url $local > `"$tunLog`" 2>&1"

$url = $null
for ($i = 0; $i -lt 90; $i++) {
    $txt = if (Test-Path $tunLog) { Get-Content $tunLog -Raw -ErrorAction SilentlyContinue } else { "" }
    if ($txt) {
        $m = [regex]::Match($txt, "https://[a-z0-9-]+\.trycloudflare\.com")
        if ($m.Success) { $url = $m.Value; break }
    }
    Start-Sleep 1
}
if (-not $url) { if (Test-Path $tunLog) { Get-Content $tunLog -Tail 20 }; Stop-Now "No tunnel address after 90s. Error above (also in $tunLog)." }

# ---- 4. Check the API through the tunnel -------------------------------
Say "Got $url  (waiting for it to go live...)"
$live = $false
for ($i = 0; $i -lt 30; $i++) { if (Health $url) { $live = $true; break }; Start-Sleep 2 }
if (-not $live) { Write-Host "Warning: tunnel not answering yet. Try the address again in 30s." -ForegroundColor Yellow }

$url | Set-Content (Join-Path $data "public-url.txt")
try { Set-Clipboard -Value $url } catch {}

# ---- 5. Done ------------------------------------------------------------
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " LIVE:  $url" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host " 1. Open the Periscope site."
Write-Host " 2. Paste the address above into the API box. Press Connect."
Write-Host " 3. Press the Helix Ledger demo button."
Write-Host " (Address is copied to your clipboard and saved in $data\public-url.txt)"
Write-Host " Keep the 'Periscope API' and 'Periscope Tunnel' windows open. Close them to stop."
