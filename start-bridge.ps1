# ClinePass Bridge launcher (Windows).
# Run via start-bridge.cmd, or directly:
#   powershell -ExecutionPolicy Bypass -File start-bridge.ps1
# Every stage is echoed AND appended to setup.log, so a failure always
# leaves evidence. The dashboard page is served by clinepass-bridge.ts
# itself (embedded HTML) - no separate index.html is needed.

$ProgressPreference = "SilentlyContinue"
$BridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $BridgeDir
$SetupLog = Join-Path $BridgeDir "setup.log"
$BridgeLog = Join-Path $BridgeDir "bridge.log"
$BridgeErrLog = Join-Path $BridgeDir "bridge.err.log"
$script:SetupOk = $false

function Free-Port {
  $conns = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Write-Output "[launcher] Freeing port 8081 (PID $($c.OwningProcess))..."
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Setup {
  Write-Output "[launcher] ClinePass Bridge setup - $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  Write-Output "[launcher] Folder: $BridgeDir"
  if (!(Test-Path (Join-Path $BridgeDir "clinepass-bridge.ts"))) {
    Write-Output "[launcher] ERROR: clinepass-bridge.ts not found here. Unzip ALL files into one folder and try again."
    return
  }
  Write-Output ""

  Write-Output "[launcher] [1/4] Checking Bun (bridge runtime)..."
  if (!(Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Output "[launcher] Bun not found - installing now (about a minute, one progress line)..."
    Invoke-RestMethod "https://bun.sh/install.ps1" | Invoke-Expression
    $env:PATH = "$env:USERPROFILE\.bun\bin;$env:PATH"
    if (!(Get-Command bun -ErrorAction SilentlyContinue)) {
      Write-Output "[launcher] ERROR: Bun install failed. Install by hand from https://bun.sh, then re-run."
      return
    }
  }
  Write-Output "[launcher] Bun OK: $(bun --version)"
  Write-Output ""

  Write-Output "[launcher] [2/4] Checking Cline CLI (provides the login)..."
  if (!(Get-Command cline -ErrorAction SilentlyContinue)) {
    Write-Output "[launcher] Cline CLI not found - installing now..."
    if (!(Get-Command npm -ErrorAction SilentlyContinue)) {
      Write-Output "[launcher] ERROR: npm not found. Install Node.js LTS from https://nodejs.org, then re-run this launcher."
      return
    }
    npm i -g cline --no-progress --no-audit --no-fund
    if (!(Get-Command cline -ErrorAction SilentlyContinue)) {
      Write-Output "[launcher] ERROR: 'npm i -g cline' failed (see output above). Fix npm, then re-run."
      return
    }
  }
  Write-Output "[launcher] Cline CLI OK: $(cline --version)"
  Write-Output ""

  Write-Output "[launcher] [3/4] Checking ClinePass login..."
  $providers = Join-Path $env:USERPROFILE ".cline\data\settings\providers.json"
  if (!(Test-Path $providers)) {
    Write-Output "[launcher] No stored login - a browser window opens next. Approve the device code there, then return here."
    cline auth --provider cline-pass
    if (!(Test-Path $providers)) {
      Write-Output "[launcher] ERROR: login did not complete (no credentials file). Re-run and approve the browser code."
      return
    }
  }
  Write-Output "[launcher] Login OK."
  Write-Output ""

  Write-Output "[launcher] [4/4] Starting bridge and waiting for it to answer..."
  Free-Port
  Start-Sleep -Seconds 2
  Remove-Item $BridgeLog -ErrorAction SilentlyContinue
  Remove-Item $BridgeErrLog -ErrorAction SilentlyContinue
  $bg = Start-Process -FilePath "bun" -ArgumentList "clinepass-bridge.ts" -WorkingDirectory $BridgeDir -WindowStyle Minimized -RedirectStandardOutput $BridgeLog -RedirectStandardError $BridgeErrLog -PassThru
  $ready = $false
  for ($i = 0; $i -lt 45; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://localhost:8081/health" -TimeoutSec 3 -UseBasicParsing
      if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
  }
  if (!$ready) {
    Write-Output "[launcher] ERROR: the bridge did not answer within ~90 seconds."
    if (Test-Path $BridgeLog) {
      Write-Output "--- bridge.log (tail) ---"
      Get-Content $BridgeLog -Tail 20
    }
    if (Test-Path $BridgeErrLog) {
      $e = Get-Content $BridgeErrLog -Tail 20
      if ($e) { Write-Output "--- bridge.err.log (tail) ---"; $e }
    }
    if ($bg) { Stop-Process -Id $bg.Id -Force -ErrorAction SilentlyContinue }
    Free-Port
    return
  }
  Write-Output "[launcher] Bridge answered the health check - opening dashboard."
  Start-Process "http://localhost:8081/"
  if ($bg) { Stop-Process -Id $bg.Id -Force -ErrorAction SilentlyContinue }
  Free-Port
  Start-Sleep -Seconds 3
  $script:SetupOk = $true
}

Invoke-Setup 2>&1 | Tee-Object -FilePath $SetupLog
if (!$script:SetupOk) {
  Write-Output "[launcher] Setup did not complete. Full log saved to: $SetupLog"
  exit 1
}

Write-Output ""
Write-Output "[launcher] ==================================================="
Write-Output "[launcher] Dashboard running at: http://localhost:8081/"
Write-Output "[launcher] Bridge is up. Leave this window open."
Write-Output "[launcher] Close this window to stop the server."
Write-Output "[launcher] ==================================================="
$crashes = 0
while ($true) {
  bun clinepass-bridge.ts
  $code = $LASTEXITCODE
  $crashes++
  Write-Output "[launcher] Bridge exited with code $code (consecutive exit #$crashes)."
  if ($crashes -ge 5) {
    Write-Output "[launcher] It keeps exiting right away. Check the error above, or force a"
    Write-Output "[launcher] token refresh from the dashboard. Press Enter to keep retrying,"
    Write-Output "[launcher] Ctrl+C (or close this window) to stop."
    Read-Host | Out-Null
    $crashes = 0
  }
  Start-Sleep -Seconds 3
}
