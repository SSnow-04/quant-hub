$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
$kronos = Join-Path $PSScriptRoot "kronos-service"
if (Test-Path (Join-Path $kronos ".venv\Scripts\python.exe")) {
  Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $kronos "start-kronos.ps1")
  Start-Sleep -Seconds 2
} else {
  Write-Host "Kronos is not installed yet. Quant Hub will start without AI overlay."
  Write-Host "Run: cd kronos-service ; .\setup-kronos.ps1"
}
npm start
