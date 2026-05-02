param(
  [string]$Url = "https://www.airbnb.com/rooms/3907276?check_in=2026-08-04&check_out=2026-08-25&guests=1&adults=1&s=67&unique_share_id=1139caa9-87d7-462e-bc94-026336f234e2"
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
  if ([double]::TryParse($m.Groups[1].Value, [ref]$n)) {
    return $n
  }

  return $null
}

function Get-Money {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) { return $null }

  $clean = $Value -replace ",", ""
  $m = [regex]::Match($clean, '\$?\s*(\d+(?:\.\d{1,2})?)')
  if (!$m.Success) { return $null }

  $n = 0
  if ([double]::TryParse($m.Groups[1].Value, [ref]$n)) {
    return $n
  }

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

  $compass = @("N", "S", "E", "W", "NE", "NW", "SE", "SW", "DC")
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

function Clean-PlaceToken {
  param([string]$Text)

  $s = Normalize-Space $Text
  if (!$s) { return "" }

  $s = $s -replace '"', ""
  $s = $s -replace "\|.*$", ""
  $s = $s -replace " - Airbnb.*$", ""
  $s = Normalize-Space $s

  if ($s.Length -gt 80) { return "" }
  if ($s -match "[{}<>\[\]]") { return "" }
  if ($s -match "(?i)wifi|kitchen|parking|pool|bedroom|bathroom|guest|review|check") { return "" }

  return $s
}

function Normalize-State {
  param([string]$Text)

  $s = Clean-PlaceToken $Text
  if (!$s) { return "" }

  $map = @{
    "District of Columbia" = "DC"
    "Florida" = "FL"
    "California" = "CA"
    "New York" = "NY"
    "North Carolina" = "NC"
    "South Carolina" = "SC"
    "Texas" = "TX"
    "Georgia" = "GA"
  }

  if ($map.ContainsKey($s)) { return $map[$s] }

  if ($s -match "^[A-Za-z]{2,3}$") { return $s.ToUpper() }

  return $s
}

function Parse-AirbnbUrlHints {
  param([string]$Url)

  try {
    $u = [Uri]$Url
    $path = [System.Uri]::UnescapeDataString($u.AbsolutePath)

    $roomId = Get-RegexValue -Text $path -Pattern '/rooms/(\d+)'

    return [PSCustomObject]@{
      platformListingId = $roomId
    }
  } catch {
    return [PSCustomObject]@{
      platformListingId = ""
    }
  }
}

function Extract-AirbnbImages {
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

    if ($v -match "(?i)(logo|favicon|sprite|icon|avatar|profile|user)") { continue }

    if ($v -match "(?i)(muscache\.com|airbnb\.com)" -and $v -match "(?i)(/im/pictures/|pictures|photo|listing)") {
      if ($imgs -notcontains $v) { $imgs += $v }
    }

    if ($imgs.Count -ge 24) { break }
  }

  return @($imgs | Select-Object -First 12)
}

function Infer-AirbnbPropertyType {
  param([string]$Text)

  $s = Normalize-Space $Text

  if ($s -match "(?i)\bapartment\b|\bapt\b") { return "apartment" }
  if ($s -match "(?i)\bhouse\b|\bhome\b") { return "house" }
  if ($s -match "(?i)\bcondo\b") { return "condo" }
  if ($s -match "(?i)\btownhouse\b|\btownhome\b") { return "townhouse" }
  if ($s -match "(?i)\bcottage\b") { return "cottage" }
  if ($s -match "(?i)\bvilla\b") { return "villa" }
  if ($s -match "(?i)\bcabin\b") { return "cabin" }
  if ($s -match "(?i)\bstudio\b") { return "studio" }
  if ($s -match "(?i)\bloft\b") { return "loft" }
  if ($s -match "(?i)\bguesthouse\b|\bguest house\b") { return "guesthouse" }
  if ($s -match "(?i)\broom\b") { return "room" }

  return ""
}

function Collect-AirbnbAmenities {
  param([string]$Text)

  $s = Normalize-Space $Text
  $amenities = @()

  function Add-Amenity {
    param([string]$Name)
    if ($script:amenities -notcontains $Name) {
      $script:amenities += $Name
    }
  }

  $script:amenities = @()

  if ($s -match "(?i)\bwifi\b|\bwi-fi\b") { Add-Amenity "WiFi" }
  if ($s -match "(?i)\bkitchen\b") { Add-Amenity "Kitchen" }
  if ($s -match "(?i)\bfree parking\b|\bparking on premises\b|\bparking\b") { Add-Amenity "Parking" }
  if ($s -match "(?i)\bwasher\b") { Add-Amenity "Washer" }
  if ($s -match "(?i)\bdryer\b") { Add-Amenity "Dryer" }
  if ($s -match "(?i)\bair conditioning\b|\bac\b") { Add-Amenity "Air conditioning" }
  if ($s -match "(?i)\bheating\b") { Add-Amenity "Heating" }
  if ($s -match "(?i)\btv\b|\btelevision\b") { Add-Amenity "TV" }
  if ($s -match "(?i)\bworkspace\b|\bdedicated workspace\b") { Add-Amenity "Workspace" }
  if ($s -match "(?i)\bpool\b|\bswimming pool\b") { Add-Amenity "Pool" }
  if ($s -match "(?i)\bhot tub\b|\bjacuzzi\b") { Add-Amenity "Hot tub" }
  if ($s -match "(?i)\bpatio\b|\bbalcony\b") { Add-Amenity "Patio/Balcony" }
  if ($s -match "(?i)\bbbq\b|\bbarbecue\b|\bgrill\b") { Add-Amenity "BBQ grill" }
  if ($s -match "(?i)\bself check-in\b|\bself check in\b") { Add-Amenity "Self check-in" }
  if ($s -match "(?i)\blockbox\b") { Add-Amenity "Lockbox" }
  if ($s -match "(?i)\bsmart lock\b") { Add-Amenity "Smart lock" }
  if ($s -match "(?i)\belevator\b") { Add-Amenity "Elevator" }
  if ($s -match "(?i)\bgym\b|\bfitness\b") { Add-Amenity "Gym" }

  return @($script:amenities)
}

function Parse-AirbnbLocation {
  param(
    [string]$Html,
    [string]$Title,
    [string]$Description
  )

  $decoded = Decode-BasicHtml $Html
  $source = Normalize-Space "$Title $Description $decoded"

  $city = ""
  $state = ""

  $pair = [regex]::Match(
    $decoded,
    '"localizedCityName"\s*:\s*"([^"]{1,80})"[\s\S]{0,220}"localizedStateName"\s*:\s*"([^"]{1,80})"',
    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
  )

  if ($pair.Success) {
    $city = Clean-PlaceToken $pair.Groups[1].Value
    $state = Normalize-State $pair.Groups[2].Value
  }

  if (!$city -and !$state) {
    $pair2 = [regex]::Match(
      $decoded,
      '"city"\s*:\s*"([^"]{1,80})"[\s\S]{0,220}"state"\s*:\s*"([^"]{1,80})"',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )

    if ($pair2.Success) {
      $city = Clean-PlaceToken $pair2.Groups[1].Value
      $state = Normalize-State $pair2.Groups[2].Value
    }
  }

  if (!$city -and !$state) {
    $m = [regex]::Match(
      $source,
      '(?:for Rent|rental|stay)\s+in\s+([^,]{2,80}),\s*([^,]{2,80})(?:,|\s+-|\s+\|)',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )

    if ($m.Success) {
      $city = Clean-PlaceToken $m.Groups[1].Value
      $state = Normalize-State $m.Groups[2].Value
    }
  }

  if (!$city -and !$state) {
    $m2 = [regex]::Match(
      $Title,
      '\s+-\s+([A-Za-zÀ-ÿ .''-]{2,60})\s+-\s+([A-Z]{2,3})\s*$',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )

    if ($m2.Success) {
      $city = Clean-PlaceToken $m2.Groups[1].Value
      $state = Normalize-State $m2.Groups[2].Value
    }
  }

  return [PSCustomObject]@{
    city = $city
    state = $state
  }
}

function Extract-AirbnbFacts {
  param(
    [string]$Html,
    [string]$FinalUrl = ""
  )

  $decoded = Decode-BasicHtml $Html
  $visibleText = Strip-Html $Html
  $hints = Parse-AirbnbUrlHints -Url $FinalUrl

  $ogTitle = Extract-Meta -Html $Html -Name "og:title"
  $twTitle = Extract-Meta -Html $Html -Name "twitter:title"
  $titleTag = Strip-Html (Get-RegexValue -Text $Html -Pattern "<title[^>]*>([\s\S]*?)</title>")

  $title = $ogTitle
  if (!$title) { $title = $twTitle }
  if (!$title) { $title = $titleTag }

  $title = $title -replace "\s*\|\s*Airbnb\s*$", ""
  $title = $title -replace "\s*-\s*Airbnb\s*$", ""
  $title = Normalize-Space $title

  $description = Extract-Meta -Html $Html -Name "og:description"
  if (!$description) { $description = Extract-Meta -Html $Html -Name "twitter:description" }
  if (!$description) { $description = Extract-Meta -Html $Html -Name "description" }
  $description = Normalize-Space $description

  $images = Extract-AirbnbImages -Html $Html
  $imageUrl = ""
  if ($images.Count -gt 0) { $imageUrl = $images[0] }

  $combo = Normalize-Space "$title $description $visibleText $decoded"

  $primary = $combo
  if ($title) {
    $idx = $combo.ToLower().IndexOf($title.ToLower())
    if ($idx -ge 0) {
      $start = [Math]::Max(0, $idx - 1500)
      $len = [Math]::Min($combo.Length - $start, 16000)
      $primary = $combo.Substring($start, $len)
    }
  }

  $primary = ($primary -split "(?i)Things to know|House rules|Safety|Cancellation|Availability|Reviews|Where you will be|Hosted by|Similar listings|Report this listing")[0]
  $primary = Normalize-Space $primary

  $bedrooms = $null
  $beds = $null
  $bathrooms = $null
  $guestsMax = $null

  $bedrooms =
    Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '"bedrooms"\s*:\s*(\d+(?:\.\d+)?)')
  if ($bedrooms -eq $null) {
    $bedrooms = Get-FirstNumber (Get-RegexValue -Text $primary -Pattern '\b(\d+(?:\.\d+)?)\s*(?:bedrooms?|BR)\b')
  }

  $beds =
    Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '"beds"\s*:\s*(\d+(?:\.\d+)?)')
  if ($beds -eq $null) {
    $beds = Get-FirstNumber (Get-RegexValue -Text $primary -Pattern '\b(\d+(?:\.\d+)?)\s*beds?\b')
  }

  $bathrooms =
    Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '"bathrooms"\s*:\s*(\d+(?:\.\d+)?)')
  if ($bathrooms -eq $null) {
    $bathrooms = Get-FirstNumber (Get-RegexValue -Text $primary -Pattern '\b(\d+(?:\.\d+)?)\s*(?:bath|baths|bathroom|bathrooms)\b')
  }

  $guestsMax =
    Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '"personCapacity"\s*:\s*(\d{1,2})')
  if ($guestsMax -eq $null) {
    $guestsMax = Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '"guestCapacity"\s*:\s*(\d{1,2})')
  }
  if ($guestsMax -eq $null) {
    $guestsMax = Get-FirstNumber (Get-RegexValue -Text $primary -Pattern '\b(\d{1,2})\s*\+?\s*guests?\b')
  }

  if ($beds -eq $null -and $bedrooms -ne $null) {
    $beds = $bedrooms
  }

  $rating =
    Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '\bRated\s+(\d(?:\.\d+)?)\s+out\s+of\s+5\b')
  if ($rating -eq $null) {
    $rating = Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '\b(\d(?:\.\d+)?)\s*(?:stars?|star rating)\b')
  }

  $reviewCount =
    Get-FirstNumber (Get-RegexValue -Text $combo -Pattern '\b(\d[\d,]*)\s+reviews?\b')

  $nightlyPrice = $null
  foreach ($pat in @(
    '\$\s*([\d,]+(?:\.\d{1,2})?)\s*(?:\/\s*)?(?:night|nightly)\b',
    '\b(?:nightly|per night)\D{0,30}\$\s*([\d,]+(?:\.\d{1,2})?)',
    '\$\s*([\d,]+(?:\.\d{1,2})?)\s+night\b'
  )) {
    if ($nightlyPrice -eq $null) {
      $nightlyPrice = Get-Money (Get-RegexValue -Text $primary -Pattern $pat)
    }
  }

  $cleaningFee = $null
  foreach ($pat in @(
    '\bcleaning\s+fee\b.{0,40}?\$\s*([\d,]+(?:\.\d{1,2})?)',
    '\$\s*([\d,]+(?:\.\d{1,2})?)\s*.{0,25}\bcleaning\s+fee\b'
  )) {
    if ($cleaningFee -eq $null) {
      $cleaningFee = Get-Money (Get-RegexValue -Text $combo -Pattern $pat)
    }
  }

  $minimumStay = ""
  $minNum = Get-RegexValue -Text $combo -Pattern '\b(?:minimum|min\.?|minimum stay)\D{0,30}(\d{1,3})\s*(night|nights|day|days|month|months)'
  if ($minNum) {
    $minimumStay = $minNum
  }

  $checkInTime =
    Get-RegexValue -Text $combo -Pattern '\bCheck[- ]?in\s+after\s+([0-9: ]{1,10}(?:AM|PM|am|pm))'
  if (!$checkInTime) {
    $checkInTime = Get-RegexValue -Text $combo -Pattern '\bCheck[- ]?in\s*[:\-]?\s*([0-9: ]{1,10}(?:AM|PM|am|pm))'
  }

  $checkOutTime =
    Get-RegexValue -Text $combo -Pattern '\bCheck[- ]?out\s+before\s+([0-9: ]{1,10}(?:AM|PM|am|pm))'
  if (!$checkOutTime) {
    $checkOutTime = Get-RegexValue -Text $combo -Pattern '\bCheck[- ]?out\s*[:\-]?\s*([0-9: ]{1,10}(?:AM|PM|am|pm))'
  }

  $checkInMethod = ""
  if ($combo -match "(?i)\bself check-in\b|\bself check in\b") {
    $checkInMethod = "Self check-in"
  }
  if ($combo -match "(?i)\blockbox\b") {
    $checkInMethod = "Self check-in (lockbox)"
  }
  if ($combo -match "(?i)\bsmart lock\b") {
    $checkInMethod = "Self check-in (smart lock)"
  }

  $location = Parse-AirbnbLocation -Html $Html -Title $title -Description $description
  $city = $location.city
  $state = $location.state

  $propertyType = Infer-AirbnbPropertyType "$title $description $primary"
  $amenities = Collect-AirbnbAmenities "$primary $description"

  $parking = $null
  if ($amenities -contains "Parking") { $parking = $true }

  $pets = ""
  if ($combo -match "(?i)\bpets?\s+(?:allowed|welcome|friendly)\b|\bpet friendly\b") {
    $pets = "yes"
  } elseif ($combo -match "(?i)\bno\s+pets?\b|\bpets?\s+not\s+allowed\b") {
    $pets = "no"
  }

  if (!$description) {
    $layoutText = @()
    if ($guestsMax -ne $null) { $layoutText += "Sleeps up to $guestsMax" }
    if ($bedrooms -ne $null) { $layoutText += "$bedrooms bedroom" }
    if ($bathrooms -ne $null) { $layoutText += "$bathrooms bathroom" }

    $locText = (@($city, $state) | Where-Object { $_ }) -join ", "
    $description = (($layoutText -join ", ") + $(if ($locText) { " in $locText." } else { "." })).Trim()
  }

  return [PSCustomObject]@{
    title = $title
    description = $description
    image_url = $imageUrl
    images = @($images)

    bedrooms = $bedrooms
    bathrooms = $bathrooms
    beds = $beds
    propertyType = $propertyType
    guestsMax = $guestsMax

    rating = $rating
    review_count = $reviewCount

    checkInTime = $checkInTime
    checkOutTime = $checkOutTime
    checkInMethod = $checkInMethod
    amenities = @($amenities)

    nightlyPrice = $nightlyPrice
    cleaningFee = $cleaningFee
    monthlyPrice = $null
    minimumStay = $minimumStay

    parking = $parking
    pets = $pets

    city = $city
    state = $state
    zip = ""
    location = (@($city, $state) | Where-Object { $_ }) -join ", "
    address_full = ""
    address_redacted = ""

    platformListingId = $hints.platformListingId

    leaseOrSale = ""
    rentOrPrice = $nightlyPrice
    sourceType = "short_term"

    furnished = $null
    utilitiesIncluded = $null
    squareFeet = $null
    propertyUse = ""
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
  $facts = if (!$blocked) { Extract-AirbnbFacts -Html $html -FinalUrl $FetchUrl } else { $null }

  return [PSCustomObject]@{
    ok = $true
    status = $picked.status
    via = $picked.via
    inputUrl = $FetchUrl
    finalUrl = $picked.finalUrl
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
Write-Host "===== AIRBNB NODE-STYLE DIRECT FETCH =====" -ForegroundColor Cyan
Write-Host $Url
$directResult = Fetch-LikeNode -FetchUrl $Url

$mergedFacts = [ordered]@{}

# Start with app result because current app extractor has better Airbnb
# title, long description, bathrooms, propertyType, and full amenities.
if ($appResult.extracted) {
  foreach ($p in $appResult.extracted.PSObject.Properties) {
    $mergedFacts[$p.Name] = $p.Value
  }
}

# Then use direct parser only for fields where it is better.
if ($directResult.facts) {
  foreach ($key in @(
    "checkInTime",
    "checkOutTime",
    "checkInMethod",
    "city",
    "state",
    "zip",
    "location",
    "pets",
    "platformListingId"
  )) {
    $v = $directResult.facts.$key
    if ($null -ne $v -and $v -ne "") {
      $mergedFacts[$key] = $v
    }
  }

  # Use direct value only if app is missing.
  foreach ($key in @(
    "bedrooms",
    "bathrooms",
    "beds",
    "propertyType",
    "guestsMax",
    "rating",
    "review_count",
    "nightlyPrice",
    "cleaningFee",
    "minimumStay",
    "parking"
  )) {
    $v = $directResult.facts.$key
    $cur = $mergedFacts[$key]

    $curMissing = ($null -eq $cur -or $cur -eq "" -or ($cur -is [array] -and $cur.Count -eq 0))
    $vUseful = ($null -ne $v -and $v -ne "" -and !($v -is [array] -and $v.Count -eq 0))

    if ($curMissing -and $vUseful) {
      $mergedFacts[$key] = $v
    }
  }

  # Merge amenities instead of replacing app amenities.
  $amenitySet = New-Object System.Collections.Generic.List[string]

  foreach ($a in @($appResult.extracted.amenities)) {
    if ($a -and !$amenitySet.Contains([string]$a)) {
      $amenitySet.Add([string]$a)
    }
  }

  foreach ($a in @($directResult.facts.amenities)) {
    if ($a -and !$amenitySet.Contains([string]$a)) {
      $amenitySet.Add([string]$a)
    }
  }

  $mergedFacts["amenities"] = @($amenitySet)

  if ($mergedFacts["amenities"] -contains "Parking") {
    $mergedFacts["parking"] = $true
  }
}

# Merge and clean images. Remove Airbnb AI/review synthesis assets.
$imageSet = New-Object System.Collections.Generic.List[string]

foreach ($img in @($appResult.extracted.images) + @($directResult.facts.images)) {
  $s = [string]$img
  if (!$s) { continue }
  if ($s -match "(?i)AirbnbPlatformAssets|Review-AI-Synthesis|avatar|profile|logo|favicon") { continue }

  if (!$imageSet.Contains($s)) {
    $imageSet.Add($s)
  }
}

if ($imageSet.Count -gt 0) {
  $mergedFacts["images"] = @($imageSet | Select-Object -First 12)
  $mergedFacts["image_url"] = $mergedFacts["images"][0]
}

# Make sure title/description stay user-friendly from app extractor.
if ($appResult.extracted.title) {
  $mergedFacts["title"] = $appResult.extracted.title
}

if ($appResult.extracted.description) {
  $mergedFacts["description"] = $appResult.extracted.description
}

$summary = [ordered]@{
  inputUrl = $Url
  note = "Airbnb direct Node-style fetch only. No SerpApi. Direct first, reader fallback second."
  appExtractor = $appResult
  directNodeStyleFetch = $directResult
  bestFacts = if ($directResult.ok -and !$directResult.blocked -and $directResult.facts) { $directResult.facts } else { $null }
  mergedBestFacts = $mergedFacts
}

$json = $summary | ConvertTo-Json -Depth 100
$json | Out-File ".\airbnb_node_direct_summary.json" -Encoding utf8

Write-Host ""
Write-Host "===== AIRBNB NODE-STYLE SUMMARY =====" -ForegroundColor Green
Write-Host $json

Write-Host ""
Write-Host "Saved:"
Write-Host ".\airbnb_node_direct_summary.json"