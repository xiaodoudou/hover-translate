# Draws each glyph on its own, measures the real ink bounds, then composes them centred with a
# known inset. Eyeballing font offsets never lands the padding right, since a glyph box is nothing
# like its ink.
Add-Type -AssemblyName System.Drawing

$dir = if ($env:ICON_OUT) { $env:ICON_OUT } else { "D:\claude\hover-translate\icons" }
$INSET = 0.155  # fraction of the tile kept clear on the left and right
$GAP   = if ($env:ICON_GAP) { [double]$env:ICON_GAP } else { 0.14 }  # fraction of the tile between the two glyph clusters
$SHIFT = if ($env:ICON_SHIFT) { [double]$env:ICON_SHIFT } else { 0.01 }  # nudges the divider off centre within that gap, towards the A

function Get-InkBounds([System.Drawing.Bitmap]$bmp) {
  $minX = $bmp.Width; $minY = $bmp.Height; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      if ($bmp.GetPixel($x, $y).A -gt 40) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  if ($maxX -lt 0) { return $null }
  return @{ X = $minX; Y = $minY; W = ($maxX - $minX + 1); H = ($maxY - $minY + 1) }
}

function Render-Glyph([string]$text, [System.Drawing.Font]$font, [int]$canvas) {
  $b = New-Object System.Drawing.Bitmap $canvas, $canvas
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawString($text, $font, [System.Drawing.Brushes]::White, 0, 0)
  $g.Dispose()
  return $b
}

foreach ($s in 16, 32, 48, 128) {
  $pad = New-Object System.Drawing.Bitmap ($s * 3), ($s * 3)   # scratch canvas
  $cjkFont = New-Object System.Drawing.Font "Microsoft YaHei", ([single]($s * 0.50)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $latFont = New-Object System.Drawing.Font "Segoe UI", ([single]($s * 0.46)), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)

  $cjkImg = Render-Glyph ([string][char]0x6587) $cjkFont ($s * 3)
  $latImg = Render-Glyph "A" $latFont ($s * 3)
  $cb = Get-InkBounds $cjkImg
  $lb = Get-InkBounds $latImg

  # Scale both so the row of ink fits exactly between the insets.
  $gapPx = $s * $GAP
  $available = $s * (1 - 2 * $INSET)
  $rowW = $cb.W + $gapPx + $lb.W
  $scale = $available / $rowW
  $rowH = [Math]::Max($cb.H, $lb.H) * $scale
  # Never let the taller glyph exceed the vertical room either.
  $maxH = $s * (1 - 2 * 0.20)
  if ($rowH -gt $maxH) { $scale = $scale * ($maxH / $rowH); $rowW = $rowW }

  $drawW = $rowW * $scale
  $startX = ($s - $drawW) / 2
  $midY = $s / 2

  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.Color]::Transparent)

  $r = [Math]::Max(2, [int]($s * 0.22)); $d = $r * 2
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc(0,0,$d,$d,180,90); $path.AddArc($s-$d,0,$d,$d,270,90)
  $path.AddArc($s-$d,$s-$d,$d,$d,0,90); $path.AddArc(0,$s-$d,$d,$d,90,90); $path.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255,14,116,144))), $path)

  # 文 in white
  $cw = $cb.W * $scale; $ch = $cb.H * $scale
  $cjkRect = New-Object System.Drawing.Rectangle ([int][Math]::Round($startX)), ([int][Math]::Round($midY - $ch/2)), ([int][Math]::Round($cw)), ([int][Math]::Round($ch))
  $g.DrawImage($cjkImg, $cjkRect, [single]$cb.X, [single]$cb.Y, [single]$cb.W, [single]$cb.H, 'Pixel')

  # A tinted to the accent colour
  $lw = $lb.W * $scale; $lh = $lb.H * $scale
  $tint = New-Object System.Drawing.Imaging.ColorMatrix
  $tint.Matrix00 = 0; $tint.Matrix11 = 0; $tint.Matrix22 = 0
  $tint.Matrix40 = 0.47; $tint.Matrix41 = 0.94; $tint.Matrix42 = 0.93
  $attr = New-Object System.Drawing.Imaging.ImageAttributes
  $attr.SetColorMatrix($tint)
  $latX = $startX + $cw + $gapPx * $scale
  $latRect = New-Object System.Drawing.Rectangle ([int][Math]::Round($latX)), ([int][Math]::Round($midY - $lh/2)), ([int][Math]::Round($lw)), ([int][Math]::Round($lh))
  $g.DrawImage($latImg, $latRect, [single]$lb.X, [single]$lb.Y, [single]$lb.W, [single]$lb.H, 'Pixel', $attr)

  # The divider, sitting in the gap
  $sepX = $startX + $cw + ($gapPx * $scale) / 2 + $s * $SHIFT
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(150,255,255,255)), ([single][Math]::Max(1.0, $s * 0.042))
  if ($env:ICON_NOSEP -eq '1') { $pen.Color = [System.Drawing.Color]::Transparent }
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawLine($pen, [single]($sepX - $s*0.028), [single]($midY + $ch*0.48), [single]($sepX + $s*0.028), [single]($midY - $ch*0.48))

  $pen.Dispose(); $attr.Dispose(); $g.Dispose()
  $cjkImg.Dispose(); $latImg.Dispose(); $cjkFont.Dispose(); $latFont.Dispose(); $pad.Dispose()
  $bmp.Save("$dir\$s.png", [System.Drawing.Imaging.ImageFormat]::Png)

  # Report the padding actually achieved.
  $check = New-Object System.Drawing.Bitmap "$dir\$s.png"
  $ink = @{ minX = $check.Width; maxX = -1 }
  for ($y = 0; $y -lt $check.Height; $y++) {
    for ($x = 0; $x -lt $check.Width; $x++) {
      $p = $check.GetPixel($x, $y)
      if ($p.A -gt 40 -and ($p.R + $p.G + $p.B) -gt 330) {
        if ($x -lt $ink.minX) { $ink.minX = $x }
        if ($x -gt $ink.maxX) { $ink.maxX = $x }
      }
    }
  }
  "{0,3}px  left pad {1,3}  right pad {2,3}" -f $s, $ink.minX, ($check.Width - 1 - $ink.maxX)
  $check.Dispose(); $bmp.Dispose()
}
