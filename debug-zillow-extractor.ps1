param(
  [string]$Url = "https://www.crexi.com/properties/537140/florida-commercial-property-in-bayside-lakes"
)

$ErrorActionPreference = "Continue"

function Normalize-Space {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return "" }
  return ($Text -replace "\s+", " ").Trim()
}

function Decode-BasicHtml {
  param([string]$Text)
  if ([string]::IsNullOrWhiteSpace($Text)) { return "" }

  $t = $Text
  $t = $t -replace "\\u002F", "/"
  $t = $t -replace "\\/", "/"
  $t = $t -replace "\\u0026", "&"
  $t = $t -replace "\\u003C", "<"
  $t = $t -replace "\\u003E", ">"
  $t = $t -replace "\\u003D", "="
  $t = $t -replace '\\"', '"'
  $t = $t -replace "&nbsp;", " "
  $t = $t -replace "&amp;", "&"
  $t = $t -replace "&quot;", '"'
  $t = $t -replace "&#39;", "'"
  $t = $t -replace "&lt;", "<"
  $t = $t -replace "&gt;", ">"
  return $t
}

function Strip-Html {
  param([string]$Html)
  if ([string]::IsNullOrWhiteSpace($Html)) { return "" }

  $t = Decode-BasicHtml $Html
  $t = $t -replace "<script[\s\S]*?</script>", " "
  $t = $t -replace "<style[\s\S]*?</style>", " "
  $t = $t -replace "<[^>]+>", " "
  return Normalize-Space $t
}

function Get-RegexValue {
  param(
    [string]$Text,
    [string]$Pattern
  )

  $m = [regex]::Match($Text, $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
  if ($m.Success -and $m.Groups.Count -gt 1) {
    return Normalize-Space $m.Groups[1].Value
  }

  return ""
}

function Get-FirstNumber {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }

  $clean = $Value -replace ",", ""
  $m = [regex]::Match($clean, '(\d+(?:\.\d+)?)')
  if (!$m.Success) { return $null }

  $n = 0
  if ([double]::TryParse($m.Groups[1].Value, [ref]$n)) { return $n }
  return $null
}

function Get-Money {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }

  $clean = $Value -replace ",", ""
  $m = [regex]::Match($clean, '\$?\s*(\d+(?:\.\d{1,2})?)')
  if (!$m.Success) { return $null }

  $n = 0
  if ([double]::TryParse($m.Groups[1].Value, [ref]$n)) { return $n }
  return $null
}

function Looks-Blocked {
  param([string]$Html)

  $t = Strip-Html $Html

  return (
    $t -match "(?i)captcha" -or
    $t -match "(?i)access\s+to\s+this\s+page\s+has\s+been\s+denied" -or
    $t -match "(?i)verify\s+you\s+are\s+a\s+human" -or
    $t -match "(?i)robot" -or
    $t -match "(?i)too\s+many\s+requests" -or
    $t -match "(?i)enable\s+javascript" -or
    $t -match "(?i)javascript\s+is\s+disabled"
  )
}

function Extract-Meta {
  param(
    [string]$Html,
    [string]$Name
  )

  $safe = [regex]::Escape($Name)

  $patterns = @(
    "<meta[^>]+(?:property|name)=[""']$safe[""'][^>]+content=[""']([^""']+)[""']",
    "<meta[^>]+content=[""']([^""']+)[""'][^>]+(?:property|name)=[""']$safe[""']"
  )

  foreach ($p in $patterns) {
    $m = [regex]::Match($Html, $p, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if ($m.Success) {
      return Normalize-Space (Decode-BasicHtml $m.Groups[1].Value)
    }
  }

  return ""
}

function Title-Case-Slug {
  param([string]$Text)

  if ([string]::IsNullOrWhiteSpace($Text)) { return "" }

  $compass = @("N", "S", "E", "W", "NE", "NW", "SE", "SW")
  $parts = (($Text -replace "[-_]+", " ") -replace "\s+", " ").Trim().ToLower().Split(" ") |
    Where-Object { $_ }

  $out = @()

  foreach ($p in $parts) {
    $upper = $p.ToUpper()
    if ($compass -contains $upper) {
      $out += $upper
    } else {
      $out += ($p.Substring(0,1).ToUpper() + $p.Substring(1))
    }
  }

  return ($out -join " ")
}

function Extract-Images {
  param([string]$Html)

  $decoded = Decode-BasicHtml $Html
  $imgs = @()

  foreach ($meta in @("og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src")) {
    $v = Extract-Meta -Html $Html -Name $meta
    if ($v -and ($imgs -notcontains $v)) { $imgs += $v }
  }

  $matches = [regex]::Matches(
    $decoded,
    'https?:\/\/[^"''\s<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^"''\s<>]*)?',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )

  foreach ($m in $matches) {
    $v = Normalize-Space $m.Value
    if (!$v) { continue }
    if ($v -match "(?i)(logo|favicon|sprite|icon|avatar)") { continue }

    if ($v -match "(?i)(crexi|images|property|listing|photos|assets)") {
      if ($imgs -notcontains $v) { $imgs += $v }
    }

    if ($imgs.Count -ge 20) { break }
  }

  return @($imgs | Select-Object -First 12)
}

function Parse-CrexiUrlHints {
  param([string]$Url)

  try {
    $u = [Uri]$Url
    $path = [System.Uri]::UnescapeDataString($u.AbsolutePath)

    $id = Get-RegexValue -Text $path -Pattern '/properties/(\d+)'
    $slug = Get-RegexValue -Text $path -Pattern '/properties/\d+/([^/?#]+)'

    return [PSCustomObject]@{
      platformListingId = $id
      titleFromSlug = Title-Case-Slug $slug
    }
  } catch {
    return [PSCustomObject]@{
      platformListingId = ""
      titleFromSlug = ""
    }
  }
}

function Parse-Address-Parts {
  param([string]$Address)

  $src = Normalize-Space $Address
  if (!$src) {
    return [PSCustomObject]@{ address_full = ""; city = ""; state = ""; zip = "" }
  }

  $m = [regex]::Match(
    $src,
    '^\s*(.+?),\s*([^,]+),\s*([A-Z]{2})\s*(\d{5})(?:-\d{4})?\s*$',
    "IgnoreCase"
  )

  if ($m.Success) {
    return [PSCustomObject]@{
      address_full = "$(Normalize-Space $m.Groups[1].Value), $(Title-Case-Slug $m.Groups[2].Value), $($m.Groups[3].Value.ToUpper()) $($m.Groups[4].Value)"
      city = Title-Case-Slug $m.Groups[2].Value
      state = $m.Groups[3].Value.ToUpper()
      zip = $m.Groups[4].Value
    }
  }

  return [PSCustomObject]@{ address_full = $src; city = ""; state = ""; zip = "" }
}

function Extract-CrexiFacts {
  param(
    [string]$Html,
    [string]$FinalUrl = ""
  )

  $decoded = Decode-BasicHtml $Html
  $visibleText = Strip-Html $Html
  $hints = Parse-CrexiUrlHints -Url $FinalUrl

  $ogTitle = Extract-Meta -Html $Html -Name "og:title"
  $twTitle = Extract-Meta -Html $Html -Name "twitter:title"
  $titleTag = Strip-Html (Get-RegexValue -Text $Html -Pattern "<title[^>]*>([\s\S]*?)</title>")

  $title = $ogTitle
  if (!$title) { $title = $twTitle }
  if (!$title) { $title = $titleTag }
  if (!$title) { $title = $hints.titleFromSlug }

  $title = $title -replace "\s*\|\s*Crexi\s*$", ""
  $title = $title -replace "\s*-\s*Crexi\s*$", ""
  $title = Normalize-Space $title

  $description = Extract-Meta -Html $Html -Name "og:description"
  if (!$description) { $description = Extract-Meta -Html $Html -Name "description" }

  $images = Extract-Images -Html $Html
  $imageUrl = ""
  if ($images.Count -gt 0) { $imageUrl = $images[0] }

  $combo = Normalize-Space "$title $description $visibleText $decoded"

  $primary = $combo
  $focusNeedle = $title
  if ($focusNeedle) {
    $idx = $combo.ToLower().IndexOf($focusNeedle.ToLower())
    if ($idx -ge 0) {
      $start = [Math]::Max(0, $idx - 2500)
      $len = [Math]::Min($combo.Length - $start, 12000)
      $primary = $combo.Substring($start, $len)
    }
  }

  $primary = ($primary -split "(?i)Similar Properties|Contact Broker|Contact Agent|Due Diligence|Investment Highlights|Executive Summary|Demographics")[0]
  $primary = Normalize-Space $primary

  # Address examples:
  # 1805 Eldron Blvd SE, Palm Bay, FL 32909
  $address = ""
  $addrMatch = [regex]::Match(
    $primary,
    '\b(\d{1,6}\s+[A-Za-z0-9 .#''-]+?\s(?:Rd|Road|St|Street|Ave|Avenue|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Cir|Circle|Way|Pkwy|Parkway|Pl|Place|Ter|Terrace|Trl|Trail|Hwy|Highway)\b\s*,\s*[A-Za-z .''-]+,\s*[A-Z]{2}\s*\d{5}(?:-\d{4})?)\b',
    "IgnoreCase"
  )

  if ($addrMatch.Success) {
    $address = Normalize-Space $addrMatch.Groups[1].Value
  }

  $addrParts = Parse-Address-Parts -Address $address

  # Money: sale price / asking price / lease rate
  $priceCandidates = @()
  foreach ($pat in @(
    '\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?: asking| sale| price)?',
    '\bPrice\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)',
    '\bAsking\s+Price\s*[:\-]?\s*\$\s*([\d,]+(?:\.\d{1,2})?)'
  )) {
    $m = [regex]::Match($primary, $pat, "IgnoreCase")
    if ($m.Success) {
      $v = Get-Money $m.Groups[1].Value
      if ($v -ne $null -and $v -ge 1000 -and $v -le 1000000000) {
        $priceCandidates += $v
      }
    }
  }

  $rentOrPrice = $null
  if ($priceCandidates.Count -gt 0) {
    $rentOrPrice = ($priceCandidates | Sort-Object | Select-Object -First 1)
  }

  # Acres / sqft
  $acres = Get-FirstNumber (Get-RegexValue -Text $primary -Pattern '\b(\d+(?:\.\d+)?)\s*acres?\b')
  $sqft = Get-FirstNumber (Get-RegexValue -Text $primary -Pattern '\b([\d,]{3,10})\s*(?:sq\.?\s*ft\.?|sqft|sf)\b')
  if ($sqft -ne $null) {
    if ($sqft -lt 100 -or $sqft -gt 50000000) { $sqft = $null }
  }

  # If only acres, store property size in squareFeet approximate for your existing schema
  if ($sqft -eq $null -and $acres -ne $null) {
    $sqft = [Math]::Round($acres * 43560)
  }

  # Property use
  $propertyUse = ""
  if ($primary -match "(?i)\bretail\b") { $propertyUse = "Retail" }
  elseif ($primary -match "(?i)\boffice\b") { $propertyUse = "Office" }
  elseif ($primary -match "(?i)\bindustrial\b|\bwarehouse\b|\bflex\b") { $propertyUse = "Industrial / warehouse" }
  elseif ($primary -match "(?i)\bland\b|\bvacant commercial parcel\b|\bcommercial parcel\b") { $propertyUse = "Land" }
  elseif ($primary -match "(?i)\bmixed use\b|\bmixed-use\b") { $propertyUse = "Mixed use" }
  elseif ($primary -match "(?i)\bmultifamily\b|\bmulti-family\b") { $propertyUse = "Multifamily" }
  elseif ($primary -match "(?i)\brestaurant\b|\bfood service\b") { $propertyUse = "Restaurant" }

  # Sale / lease
  $leaseOrSale = ""
  if ($primary -match "(?i)\bfor sale\b|\bcommercial real estate for sale\b|\basking price\b") {
    $leaseOrSale = "For sale"
  } elseif ($primary -match "(?i)\bfor lease\b|\blease rate\b|\bavailable for lease\b") {
    $leaseOrSale = "For lease"
  }

  if (!$leaseOrSale -and $FinalUrl -match "/properties/") {
    $leaseOrSale = "For sale"
  }

  if (!$description) {
    $description =
      Get-RegexValue -Text $primary -Pattern '(Marketing description\s+[\s\S]{20,900}?)(?:\s+For more information|\s+Location:|\s+Investment|\s+Highlights|$)'
    $description = $description -replace "^(?i)Marketing description\s+", ""
  }

  if (!$description) {
    $description =
      Get-RegexValue -Text $primary -Pattern '((?:Vacant|Excellent|Prime|Located|Commercial|Retail|Office|Industrial|Land)[\s\S]{30,800}?)(?:\s+For more information|\s+Location:|\s+Contact|$)'
  }

  return [PSCustomObject]@{
    title = $title
    description = Normalize-Space $description
    image_url = $imageUrl
    images = @($images | Select-Object -First 12)

    sourceType = "commercial"
    propertyUse = $propertyUse
    leaseOrSale = $leaseOrSale
    rentOrPrice = $rentOrPrice
    monthlyPrice = $null
    squareFeet = $sqft
    acres = $acres

    city = $addrParts.city
    state = $addrParts.state
    zip = $addrParts.zip
    location = (@($addrParts.city, $addrParts.state) | Where-Object { $_ }) -join ", "
    address_full = $addrParts.address_full
    address_redacted = if ($addrParts.address_full) { $addrParts.address_full -replace "^\s*\d+[\w\-]*\s+", "••• " } else { "" }

    platformListingId = $hints.platformListingId

    # keep residential/STR fields blank
    bedrooms = $null
    bathrooms = $null
    beds = $null
    guestsMax = $null
    checkInTime = ""
    checkOutTime = ""
    checkInMethod = ""
    amenities = @()
    nightlyPrice = $null
    cleaningFee = $null
    furnished = $null
    utilitiesIncluded = $null
    parking = $null
    pets = ""
    rating = $null
    review_count = $null
  }
}

function Fetch-DirectHtml {
  param([string]$FetchUrl)

  $headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
    "Accept" = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    "Accept-Language" = "en-US,en;q=0.9"
  }

  try {
    $r = Invoke-WebRequest `
      -Uri $FetchUrl `
      -Headers $headers `
      -MaximumRedirection 10 `
      -UseBasicParsing `
      -TimeoutSec 35

    $html = [string]$r.Content

    $finalUrl = $FetchUrl
    try { $finalUrl = $r.BaseResponse.ResponseUri.AbsoluteUri } catch {}

    return [PSCustomObject]@{
      ok = $true
      via = "direct"
      status = $r.StatusCode
      finalUrl = $finalUrl
      html = $html
      error = ""
    }
  } catch {
    return [PSCustomObject]@{
      ok = $false
      via = "direct"
      status = "fetch_error"
      finalUrl = $FetchUrl
      html = ""
      error = $_.Exception.Message
    }
  }
}

function Fetch-ReaderHtml {
  param([string]$FetchUrl)

  $readerUrl = "https://r.jina.ai/" + $FetchUrl

  $headers = @{
    "User-Agent" = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
    "Accept" = "text/plain,text/markdown,*/*"
    "Accept-Language" = "en-US,en;q=0.9"
  }

  try {
    $r = Invoke-WebRequest `
      -Uri $readerUrl `
      -Headers $headers `
      -MaximumRedirection 10 `
      -UseBasicParsing `
      -TimeoutSec 45

    $html = [string]$r.Content

    return [PSCustomObject]@{
      ok = $true
      via = "reader"
      status = $r.StatusCode
      finalUrl = $FetchUrl
      html = $html
      error = ""
    }
  } catch {
    return [PSCustomObject]@{
      ok = $false
      via = "reader"
      status = "reader_error"
      finalUrl = $FetchUrl
      html = ""
      error = $_.Exception.Message
    }
  }
}

function Fetch-LikeNode {
  param([string]$FetchUrl)

  $direct = Fetch-DirectHtml -FetchUrl $FetchUrl
  $picked = $direct

  if (!$direct.ok -or !$direct.html -or $direct.html.Length -lt 300 -or (Looks-Blocked $direct.html)) {
    $reader = Fetch-ReaderHtml -FetchUrl $FetchUrl

    if ($reader.ok -and $reader.html -and $reader.html.Length -gt 300 -and !(Looks-Blocked $reader.html)) {
      $picked = $reader
    }
  }

  if (!$picked.ok -or !$picked.html) {
    return [PSCustomObject]@{
      ok = $false
      status = $picked.status
      via = $picked.via
      inputUrl = $FetchUrl
      finalUrl = $FetchUrl
      htmlLength = 0
      textLength = 0
      blocked = $false
      facts = $null
      error = $picked.error
    }
  }

  $html = [string]$picked.html
  $blocked = Looks-Blocked $html
  $facts = if (!$blocked) { Extract-CrexiFacts -Html $html -FinalUrl $FetchUrl } else { $null }

  return [PSCustomObject]@{
    ok = $true
    status = $picked.status
    via = $picked.via
    inputUrl = $FetchUrl
    finalUrl = $FetchUrl
    htmlLength = $html.Length
    textLength = (Strip-Html $html).Length
    blocked = $blocked
    facts = $facts
    error = ""
  }
}

function Test-AppExtractor {
  param([string]$TestUrl)

  try {
    $body = @{ url = $TestUrl } | ConvertTo-Json

    $res = Invoke-RestMethod `
      -Uri "http://localhost:5001/api/ps/str/extract_public" `
      -Method POST `
      -ContentType "application/json" `
      -Body $body `
      -TimeoutSec 60

    return [PSCustomObject]@{
      ok = $true
      error = ""
      extracted = $res.extracted
      debugVersion = $res.debugVersion
      partial = $res.partial
    }
  } catch {
    return [PSCustomObject]@{
      ok = $false
      error = $_.Exception.Message
      extracted = $null
      debugVersion = ""
      partial = $null
    }
  }
}

Write-Host ""
Write-Host "===== APP EXTRACTOR =====" -ForegroundColor Cyan
Write-Host $Url
$appResult = Test-AppExtractor -TestUrl $Url

Write-Host ""
Write-Host "===== CREXI NODE-STYLE DIRECT FETCH =====" -ForegroundColor Cyan
Write-Host $Url
$directResult = Fetch-LikeNode -FetchUrl $Url

$summary = [ordered]@{
  inputUrl = $Url
  note = "CREXI direct Node-style fetch only. No SerpApi. Direct first, reader fallback second."
  appExtractor = $appResult
  directNodeStyleFetch = $directResult
  bestFacts = if ($directResult.ok -and !$directResult.blocked -and $directResult.facts) { $directResult.facts } else { $null }
}

$json = $summary | ConvertTo-Json -Depth 80
$json | Out-File ".\crexi_node_direct_summary.json" -Encoding utf8

Write-Host ""
Write-Host "===== CREXI NODE-STYLE SUMMARY =====" -ForegroundColor Green
Write-Host $json

Write-Host ""
Write-Host "Saved:"
Write-Host ".\crexi_node_direct_summary.json"