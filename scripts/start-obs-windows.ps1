param(
  [string]$ObsPath = "$env:ProgramFiles\obs-studio\bin\64bit\obs64.exe",
  [string]$Collection = "茨香祭ローカル配信"
)

if (-not (Test-Path -LiteralPath $ObsPath)) {
  throw "OBS Studio was not found at $ObsPath. Pass -ObsPath with the obs64.exe location."
}

Start-Process -FilePath $ObsPath -ArgumentList @('--collection', $Collection)
