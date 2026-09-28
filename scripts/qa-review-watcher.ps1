[CmdletBinding()]
param(
  [string]$Repo = "zolo0548152101-afk/ZOLO",
  [int]$PullRequest = 2,
  [string]$SubmittedSha = "",
  [int]$PollSeconds = 90,
  [string]$StateFile = "artifacts/qa/reviewer-watcher-state.json",
  [string]$LockFile = "artifacts/qa/reviewer-watcher.lock",
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$FixtureCommentsPath = "",
  [switch]$DryRun,
  [switch]$Once,
  [string]$CodexCommand = "codex"
)

$ErrorActionPreference = "Stop"
$allowedKinds = @("REVIEW_PASS", "REVIEW_CHANGES_REQUIRED", "REVIEW_BLOCKED")
$resolvedRoot = (Resolve-Path -LiteralPath $RepoRoot).Path
$statePath = if ([IO.Path]::IsPathRooted($StateFile)) { $StateFile } else { Join-Path $resolvedRoot $StateFile }
$lockPath = if ([IO.Path]::IsPathRooted($LockFile)) { $LockFile } else { Join-Path $resolvedRoot $LockFile }
$resolvedState = [IO.Path]::GetFullPath($statePath)
$resolvedLock = [IO.Path]::GetFullPath($lockPath)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedState) | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $resolvedLock) | Out-Null

try {
  $lockStream = [IO.File]::Open($resolvedLock, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
  throw "Another QA review orchestrator already holds the lock: $resolvedLock"
}

function Save-State([object]$state) {
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resolvedState -Encoding utf8
}

function New-State {
  return [pscustomobject]@{
    last_submitted_sha = $SubmittedSha
    last_processed_review_comment_id = 0
    current_phase = "3.1"
    current_work_unit = "Phase 3.1 — Golden Harness Hardening"
    current_status = "watching"
    last_directive_kind = $null
    last_directive_body = $null
    last_invocation_started_at = $null
    invocation_count = 0
  }
}

function Read-State {
  if (-not (Test-Path -LiteralPath $resolvedState)) { return New-State }
  $state = Get-Content -LiteralPath $resolvedState -Raw | ConvertFrom-Json
  if (-not ($state.PSObject.Properties.Name -contains "last_submitted_sha")) { $state | Add-Member NoteProperty last_submitted_sha $SubmittedSha }
  if (-not ($state.PSObject.Properties.Name -contains "last_processed_review_comment_id")) {
    $seen = @($state.seen_comment_ids | ForEach-Object { [int64]$_ })
    $state | Add-Member NoteProperty last_processed_review_comment_id ($(if ($seen.Count) { ($seen | Measure-Object -Maximum).Maximum } else { 0 }))
  }
  if (-not ($state.PSObject.Properties.Name -contains "current_phase")) { $state | Add-Member NoteProperty current_phase "3.1" }
  if (-not ($state.PSObject.Properties.Name -contains "current_work_unit")) { $state | Add-Member NoteProperty current_work_unit "Phase 3.1 — Golden Harness Hardening" }
  if (-not ($state.PSObject.Properties.Name -contains "current_status")) { $state | Add-Member NoteProperty current_status "watching" }
  if (-not ($state.PSObject.Properties.Name -contains "invocation_count")) { $state | Add-Member NoteProperty invocation_count 0 }
  return $state
}

function Assert-CodexAvailable {
  $command = Get-Command $CodexCommand -ErrorAction SilentlyContinue
  if ($null -eq $command) { throw "Missing prerequisite: '$CodexCommand' CLI is not available on PATH" }
  $version = (& $CodexCommand --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) { throw "Missing prerequisite: '$CodexCommand --version' failed" }
  return $version
}

function Get-Comments {
  if (-not [string]::IsNullOrWhiteSpace($FixtureCommentsPath)) {
    return @(Get-Content -LiteralPath $FixtureCommentsPath -Raw | ConvertFrom-Json)
  }
  $uri = "https://api.github.com/repos/$Repo/issues/$PullRequest/comments?per_page=100"
  return @(Invoke-RestMethod -Uri $uri -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "haim-yahad-qa-orchestrator" } -Method Get)
}

function Find-Directive([object[]]$comments, [object]$state) {
  $lastId = [int64]$state.last_processed_review_comment_id
  foreach ($comment in ($comments | Sort-Object { [int64]$_.id } -Descending)) {
    $commentId = [int64]$comment.id
    if ($commentId -le $lastId) { continue }
    $lines = @($comment.body -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -lt 2 -or $allowedKinds -notcontains $lines[0]) { continue }
    $match = [regex]::Match(($lines -join "`n"), '(?m)^reviewed_sha:\s*([0-9a-f]{40})\s*$')
    if (-not $match.Success -or $match.Groups[1].Value -ne $state.last_submitted_sha) { continue }
    return [pscustomobject]@{ kind = $lines[0]; reviewed_sha = $state.last_submitted_sha; comment_id = $commentId; url = $comment.html_url; body = $comment.body }
  }
  return $null
}

function Build-Prompt([object]$directive) {
  return @"
You are resuming the Haim Yahad QA coordination loop from the repository root.
Current authorized phase/work unit: Phase 3.1 — Golden Harness Hardening only.
Do not start Phase 4. Do not deploy. Do not touch live WAHA or the live DB.
Read the repository, the latest checkpoint, and the reviewer directive below.
Implement only the requested correction. Run the required tests and gates.
Before ending, update the required evidence, commit and push qa-build, and post READY_FOR_REVIEW with the exact full pushed SHA when the gates pass.
Preserve unrelated user changes; do not resend uncertain messages or invent consent.

Reviewer directive:
$($directive.body)
"@
}

function Set-Status([object]$state, [string]$status) {
  $state.current_status = $status
  Save-State $state
}

function Wait-ForGreenWorkflow([string]$sha) {
  $uri = "https://api.github.com/repos/$Repo/actions/runs?head_sha=$sha&per_page=20"
  for ($attempt = 1; $attempt -le 30; $attempt++) {
    $payload = Invoke-RestMethod -Uri $uri -Headers @{ Accept = "application/vnd.github+json"; "User-Agent" = "haim-yahad-qa-orchestrator" } -Method Get
    $success = @($payload.workflow_runs | Where-Object { $_.name -eq "verification" -and $_.status -eq "completed" -and $_.conclusion -eq "success" } | Sort-Object id -Descending | Select-Object -First 1)
    if ($success.Count -gt 0) { return $success[0] }
    Start-Sleep -Seconds 10
  }
  return $null
}

function Invoke-CodexDirective([object]$state, [object]$directive) {
  $prompt = Build-Prompt $directive
  $state.current_status = "invoking_codex"
  $state.last_directive_kind = $directive.kind
  $state.last_directive_body = $directive.body
  $state.last_processed_review_comment_id = $directive.comment_id
  $state.last_invocation_started_at = (Get-Date).ToUniversalTime().ToString("o")
  $state.invocation_count = [int]$state.invocation_count + 1
  Save-State $state

  $commandLine = "$CodexCommand exec --cd `"$resolvedRoot`" --sandbox workspace-write -"
  if ($DryRun) {
    $state.current_status = "watching"
    Save-State $state
    $hashStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($prompt))
    try { $promptHash = (Get-FileHash -InputStream $hashStream -Algorithm SHA256).Hash } finally { $hashStream.Dispose() }
    return [pscustomobject]@{ status = "invocation_planned"; comment_id = $directive.comment_id; kind = $directive.kind; command = $commandLine; prompt_sha256 = $promptHash }
  }

  $logPath = Join-Path $resolvedRoot ("artifacts/qa/codex-review-run-" + $directive.comment_id + ".log")
  $output = $prompt | & $CodexCommand exec --cd $resolvedRoot --sandbox workspace-write - 2>&1 | Out-String
  $exitCode = $LASTEXITCODE
  $output | Set-Content -LiteralPath $logPath -Encoding utf8
  if ($exitCode -ne 0) {
    Set-Status $state "codex_failed"
    throw "codex exec failed with exit code $exitCode; log: $logPath"
  }

  $state.current_status = "post_run_verifying"
  Save-State $state
  $porcelain = @(git -C $resolvedRoot status --porcelain)
  $head = (git -C $resolvedRoot rev-parse HEAD).Trim()
  $origin = (git -C $resolvedRoot rev-parse origin/qa-build).Trim()
  if ($porcelain.Count -ne 0 -or $head -ne $origin) {
    Set-Status $state "post_run_verification_failed"
    throw "post-run convergence failed: clean=$($porcelain.Count -eq 0), head_equals_origin=$($head -eq $origin), head=$head, origin=$origin"
  }

  if ($directive.body -match '(?i)(CI|GitHub verification|exact-SHA)') {
    $run = Wait-ForGreenWorkflow $head
    if ($null -eq $run) {
      Set-Status $state "ci_verification_failed"
      throw "no completed successful GitHub verification workflow found for $head"
    }
  }
  $state.last_submitted_sha = $head
  $state.current_status = "watching"
  Save-State $state
  return [pscustomobject]@{ status = "codex_completed"; comment_id = $directive.comment_id; submitted_sha = $head; log = $logPath }
}

try {
  $codexVersion = Assert-CodexAvailable
  $state = Read-State
  if (-not [string]::IsNullOrWhiteSpace($SubmittedSha)) { $state.last_submitted_sha = $SubmittedSha }
  if ([string]::IsNullOrWhiteSpace($state.last_submitted_sha) -or $state.last_submitted_sha -notmatch '^[0-9a-f]{40}$') { throw "No valid last_submitted_sha is configured" }
  Save-State $state
  Write-Output (ConvertTo-Json @{ status = "watching"; repo = $Repo; pull_request = $PullRequest; submitted_sha = $state.last_submitted_sha; poll_seconds = $PollSeconds; codex_version = $codexVersion; dry_run = [bool]$DryRun } -Compress)

  do {
    $comments = Get-Comments
    $directive = Find-Directive $comments $state
    if ($null -eq $directive) {
      $maxId = @($comments | ForEach-Object { [int64]$_.id } | Measure-Object -Maximum).Maximum
      if ($maxId -and $maxId -gt [int64]$state.last_processed_review_comment_id) { $state.last_processed_review_comment_id = $maxId; Save-State $state }
      Write-Output (ConvertTo-Json @{ status = "no_new_directive"; last_processed_review_comment_id = $state.last_processed_review_comment_id } -Compress)
    } elseif ($directive.kind -eq "REVIEW_BLOCKED") {
      $state.last_processed_review_comment_id = $directive.comment_id
      $state.current_status = "blocked"
      Save-State $state
      Write-Output (ConvertTo-Json @{ status = "blocked"; comment_id = $directive.comment_id; reviewed_sha = $directive.reviewed_sha; body = $directive.body } -Depth 8)
      break
    } else {
      $result = Invoke-CodexDirective $state $directive
      Write-Output (ConvertTo-Json $result -Depth 8)
      $state = Read-State
    }
    if ($Once) { break }
    Start-Sleep -Seconds $PollSeconds
  } while ($true)
}
finally {
  if ($null -ne $lockStream) { $lockStream.Dispose() }
}
