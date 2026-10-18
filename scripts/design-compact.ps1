param([int]$MaxSide = 180, [int]$JpegQuality = 65)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$designRoot = Join-Path $projectRoot 'design'
$assetRoot = Join-Path $projectRoot 'dist/assets'
$thumbnailRoot = Join-Path $designRoot '.thumbnails'
[IO.Directory]::CreateDirectory($thumbnailRoot) | Out-Null
$boardPath = Join-Path $designRoot 'juzi-design-board.svg'
$outputPath = Join-Path $designRoot 'juzi-design-board-compact.svg'
$markup = [IO.File]::ReadAllText($boardPath)
# Figma's SVG clipboard parser expects the SVG 1.1 xlink image attribute.
$markup = [regex]::Replace($markup, '(<image\b[^>]*?)\shref="', '$1 xlink:href="')
if(-not $markup.Contains('xmlns:xlink="http://www.w3.org/1999/xlink"')) {
  $markup = $markup.Replace('<svg xmlns="http://www.w3.org/2000/svg"', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"')
}
$jpegCodec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object {$_.MimeType -eq 'image/jpeg'}
$qualityParameters = New-Object Drawing.Imaging.EncoderParameters(1)
$qualityParameters.Param[0] = New-Object Drawing.Imaging.EncoderParameter([Drawing.Imaging.Encoder]::Quality, [long]$JpegQuality)
foreach ($file in Get-ChildItem -LiteralPath $assetRoot -Filter *.jpg) {
  $original = [Drawing.Image]::FromFile($file.FullName)
  try {
    $scale = [Math]::Min(1, $MaxSide / [Math]::Max($original.Width, $original.Height))
    $width = [Math]::Max(1,[int][Math]::Round($original.Width * $scale))
    $height = [Math]::Max(1,[int][Math]::Round($original.Height * $scale))
    $thumbnail = New-Object Drawing.Bitmap($width,$height)
    $graphics = [Drawing.Graphics]::FromImage($thumbnail)
    try {
      $graphics.Clear([Drawing.Color]::White)
      $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.DrawImage($original,0,0,$width,$height)
      $thumbnailPath = Join-Path $thumbnailRoot $file.Name
      $thumbnail.Save($thumbnailPath,$jpegCodec,$qualityParameters)
    } finally {
      $graphics.Dispose()
      $thumbnail.Dispose()
    }
    $before = [Convert]::ToBase64String([IO.File]::ReadAllBytes($file.FullName))
    $after = [Convert]::ToBase64String([IO.File]::ReadAllBytes($thumbnailPath))
    $markup = $markup.Replace('data:image/jpeg;base64,'+$before,'data:image/jpeg;base64,'+$after)
  } finally {
    $original.Dispose()
  }
}
$qualityParameters.Dispose()
[IO.File]::WriteAllText($outputPath,$markup,[Text.UTF8Encoding]::new($false))
$xml = New-Object Xml.XmlDocument
$xml.Load($outputPath)
$allIds = @($xml.SelectNodes('//*[@id]') | ForEach-Object {$_.GetAttribute('id')})
$duplicates = @($allIds | Group-Object | Where-Object {$_.Count -gt 1})
if($duplicates.Count -gt 0){throw 'Duplicate SVG ids found'}
Write-Output ('Compact board: '+$outputPath)
Write-Output ('Bytes: '+(Get-Item -LiteralPath $outputPath).Length)
Write-Output ('Max raster side: '+$MaxSide+'px; JPEG quality: '+$JpegQuality+'; duplicate IDs: 0')
