# Live smoke test of the running EventFeed server (MCP over HTTP, real web fetch, dry-run upload).
# Start the server first in another terminal:  npm.cmd run dev
# Run:  powershell -ExecutionPolicy Bypass -File scripts\demo.ps1
try {
    Invoke-RestMethod 'http://127.0.0.1:3000/api/instructions' | Out-Null
} catch {
    Write-Host 'EventFeed is not running at http://127.0.0.1:3000. Start it with: npm.cmd run dev'
    exit 1
}
npm.cmd run --silent smoke
Write-Host 'DONE'
