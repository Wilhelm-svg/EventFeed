# EventFeed demo: upload the curated events through the API, then query them back.
# Start the server first in another terminal:  npm.cmd run dev
# Run:  powershell -ExecutionPolicy Bypass -File scripts\demo.ps1
$base = 'http://127.0.0.1:3000'

try {
    $guide = Invoke-RestMethod "$base/api"
    Write-Host "Server is up: $($guide.name). $($guide.status)"
} catch {
    Write-Host "EventFeed is not running at $base. Start it with: npm.cmd run dev"
    exit 1
}

Write-Host "`n--- Upload ---"
npm.cmd run --silent upload

function Search($when) {
    $url = "$base/api/events/search?location=Hermanus&when=$([uri]::EscapeDataString($when))"
    Write-Host "`n--- when=$when ---"
    try {
        $r = Invoke-RestMethod $url
        Write-Host $r.summary
        foreach ($e in $r.results) { Write-Host "  - $($e.name): $($e.whenText)" }
    } catch {
        $err = ($_.ErrorDetails.Message | ConvertFrom-Json).error
        Write-Host "  400: $($err.message)"
        Write-Host "  Suggestions: $($err.suggestions -join ' | ')"
    }
}

Search 'August 2027'
Search 'June 2027'
Search 'this Saturday'
Search 'next summer'

Write-Host "`n--- Upload again (duplicates should be skipped) ---"
npm.cmd run --silent upload

Write-Host 'DONE'
