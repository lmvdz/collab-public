param(
  [Parameter(Position = 0)]
  [string]$Method = "ping",
  [Parameter(Position = 1)]
  [string]$ParamsJson = "",
  [string]$Socket
)

$socketFile = Join-Path $HOME ".collaborator\socket-path"
if (-not $Socket) {
  if (-not (Test-Path $socketFile)) {
    throw "Collaborator is not running. Expected socket breadcrumb at $socketFile"
  }
  $Socket = (Get-Content $socketFile -Raw).Trim()
}

$params = $null
if ($ParamsJson) {
  try {
    $params = $ParamsJson | ConvertFrom-Json
  } catch {
    throw "Invalid params JSON: $($_.Exception.Message)"
  }
}

$payload = @{
  jsonrpc = "2.0"
  id = 1
  method = $Method
}
if ($null -ne $params) {
  $payload.params = $params
}
$line = ($payload | ConvertTo-Json -Depth 16 -Compress) + "`n"

if ($Socket.StartsWith("\\.\pipe\")) {
  $pipeName = $Socket.Substring("\\.\pipe\".Length)
  $client = [System.IO.Pipes.NamedPipeClientStream]::new(
    ".",
    $pipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None
  )
  $client.Connect(5000)
  $writer = [System.IO.StreamWriter]::new($client, [System.Text.Encoding]::UTF8, 4096, $true)
  $writer.AutoFlush = $true
  $writer.Write($line)

  $reader = [System.IO.StreamReader]::new($client, [System.Text.Encoding]::UTF8, $false, 4096, $true)
  $responseLine = $reader.ReadLine()
  $reader.Dispose()
  $writer.Dispose()
  $client.Dispose()
} else {
  throw "Unix socket endpoints are not supported by collab.ps1"
}

if (-not $responseLine) {
  throw "No response from Collaborator."
}

$response = $responseLine | ConvertFrom-Json
if ($response.error) {
  throw "$($response.error.message) (code $($response.error.code))"
}

if ($null -eq $response.result) {
  "null"
} elseif ($response.result -is [string] -or $response.result -is [ValueType]) {
  $response.result
} else {
  $response.result | ConvertTo-Json -Depth 16
}
