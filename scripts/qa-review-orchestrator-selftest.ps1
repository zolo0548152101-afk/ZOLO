[CmdletBinding()]
param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"
$tempDir = Join-Path $RepoRoot ("artifacts/qa/.orchestrator-selftest-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$fixture = Join-Path $tempDir "comments.json"
$state = Join-Path $tempDir "state.json"

try {
  @(
    [pscustomobject]@{ id = 100; created_at = "2026-09-28T18:00:00Z"; html_url = "https://example.invalid/100"; body = "REVIEW_CHANGES_REQUIRED`nreviewed_sha: 0000000000000000000000000000000000000000`nignored: stale" },
    [pscustomobject]@{ id = 101; created_at = "2026-09-28T18:01:00Z"; html_url = "https://example.invalid/101"; body = "REVIEW_CHANGES_REQUIRED`nreviewed_sha: 1111111111111111111111111111111111111111`nrequested: detector coverage" }
  ) | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $fixture -Encoding utf8

  $sha = "1111111111111111111111111111111111111111"
  $first = & pwsh -NoProfile -File (Join-Path $RepoRoot "scripts/qa-review-watcher.ps1") -RepoRoot $RepoRoot -SubmittedSha $sha -FixtureCommentsPath $fixture -StateFile $state -PollSeconds 1 -Once -DryRun 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $first -notmatch 'invocation_planned' -or $first -notmatch 'comment_id.*101') {
    throw "expected first dry-run to plan one matching Codex invocation; output: $first"
  }

  $second = & pwsh -NoProfile -File (Join-Path $RepoRoot "scripts/qa-review-watcher.ps1") -RepoRoot $RepoRoot -SubmittedSha $sha -FixtureCommentsPath $fixture -StateFile $state -PollSeconds 1 -Once -DryRun 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $second -notmatch 'no_new_directive' -or $second -match 'invocation_planned') {
    throw "expected duplicate matching directive to be ignored; output: $second"
  }

  $saved = Get-Content -LiteralPath $state -Raw | ConvertFrom-Json
  if ($saved.last_processed_review_comment_id -ne 101 -or $saved.current_status -ne "watching") {
    throw "persistent state did not return to watching after dry-run"
  }

  Write-Output "QA_REVIEW_ORCHESTRATOR_SELFTEST PASS"
  Write-Output "review comment detected -> invocation command planned -> state transitioned -> duplicate ignored"
}
finally {
  if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
}
