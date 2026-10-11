# KlippyDash static file server (no Python/Node needed).
# Serves the src\ folder on http://localhost:<port>/  (default 8899).
# Usage:  powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8899]
param([int]$Port = 8899)

$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot "src"

$mime = @{
  ".html"="text/html; charset=utf-8"; ".htm"="text/html; charset=utf-8";
  ".js"="application/javascript; charset=utf-8"; ".css"="text/css; charset=utf-8";
  ".json"="application/json; charset=utf-8"; ".webmanifest"="application/manifest+json";
  ".png"="image/png"; ".jpg"="image/jpeg"; ".jpeg"="image/jpeg"; ".gif"="image/gif";
  ".svg"="image/svg+xml"; ".ico"="image/x-icon"; ".mp3"="audio/mpeg"; ".woff2"="font/woff2";
  ".txt"="text/plain; charset=utf-8"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "KlippyDash serving $root"
Write-Host "Open:  http://localhost:$Port/"
Write-Host "Press Ctrl+C to stop."

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response
    $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath.TrimStart("/"))
    if ([string]::IsNullOrEmpty($rel)) { $rel = "index.html" }
    $path = Join-Path $root $rel
    # keep inside root
    $full = [System.IO.Path]::GetFullPath($path)
    if (-not $full.StartsWith([System.IO.Path]::GetFullPath($root))) {
      $res.StatusCode = 403; $res.Close(); continue
    }
    if (Test-Path $full -PathType Leaf) {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $ct = $mime[$ext]; if (-not $ct) { $ct = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentType = $ct
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $res.StatusCode = 404
      $nf = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $rel")
      $res.OutputStream.Write($nf, 0, $nf.Length)
    }
    $res.OutputStream.Close()
  } catch {
    try { $res.StatusCode = 500; $res.Close() } catch {}
  }
}
