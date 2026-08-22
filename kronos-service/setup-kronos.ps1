$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv")) { python -m venv .venv }
& .\.venv\Scripts\python.exe -m pip install --upgrade pip
& .\.venv\Scripts\pip.exe install -r requirements.txt
if (-not (Test-Path "vendor\Kronos")) {
  git clone --depth 1 https://github.com/shiyu-coder/Kronos.git vendor\Kronos
}
Write-Host "Kronos setup complete. Run .\start-kronos.ps1"
