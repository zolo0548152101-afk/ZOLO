[CmdletBinding()]
param(
  [string]$Repo = "zolo0548152101-afk/ZOLO",
  [int]$PullRequest = 2,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-f]{40}$')][string]$SubmittedSha,
  [int]$PollSeconds = 90,
  [string]$StateFile = "artifacts/qa/reviewer-watcher-state.json"
)

$ErrorActionPreference = "Stop"
$apiUri = "https://api.github.com/repos/$Repo/issues/$PullRequest/comments?per_page=100"
$headers = @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "haim-yahad-qa-review-watcher" }
$resolvedState = [IO.Path]::GetFullPath((Join-Path (Get-Location) $StateFile))
$stateDirectory = Split-Path -Parent $resolvedState
New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null

function Read-State {
  if (Test-Path -LiteralPath $resolvedState) {
    return (Get-Content -LiteralPath $resolvedState -Raw | ConvertFrom-Json)
  }
  return [pscustomobject]@{ seen_comment_ids = @() }
}

function Save-State($state) {
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $resolvedState -Encoding utf8
}

function Find-MatchingDirective($comments, $state) {
  foreach ($comment in ($comments | Sort-Object { [DateTime]$_.created_at } -Descending)) {
    if ($state.seen_comment_ids -contains [int64]$comment.id) { continue }
    $lines = @($comment.body -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -lt 2) { continue }
    $kind = $lines[0]
    if ($kind -notin @("REVIEW_PASS", "REVIEW_CHANGES_REQUIRED", "REVIEW_BLOCKED")) { continue }
    $match = [regex]::Match(($lines -join "`n"), '(?m)^reviewed_sha:\s*([0-9a-f]{40})\s*$')
    if (-not $match.Success -or $match.Groups[1].Value -ne $SubmittedSha) { continue }
    return [pscustomobject]@{ kind = $kind; reviewed_sha = $SubmittedSha; comment_id = [int64]$comment.id; url = $comment.html_url; body = $comment.body }
  }
  return $null
}

$state = Read-State
Write-Output (ConvertTo-Json @{ status = "watching"; repo = $Repo; pull_request = $PullRequest; submitted_sha = $SubmittedSha; poll_seconds = $PollSeconds } -Compress)
while ($true) {
  try {
    $comments = Invoke-RestMethod -Uri $apiUri -Headers $headers -Method Get
    $directive = Find-MatchingDirective $comments $state
    $state.seen_comment_ids = @($comments | ForEach-Object { [int64]$_.id })
    Save-State $state
    if ($null -ne $directive) {
      Write-Output (ConvertTo-Json $directive -Depth 5)
      exit 0
    }
  } catch {
    Write-Error ("GitHub polling failed: " + $_.Exception.Message)
  }
  Start-Sleep -Seconds $PollSeconds
}
