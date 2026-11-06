param(
  [Parameter(Mandatory=$true)][string]$BucketName,
  [Parameter(Mandatory=$true)][string]$DistributionId
)

$ErrorActionPreference = 'Stop'
$FrontendPath = Join-Path $PSScriptRoot 'frontend'
$DistPath = Join-Path $FrontendPath 'dist'

if (-not (Test-Path $FrontendPath)) {
  throw "Frontend folder not found: $FrontendPath"
}

Push-Location $FrontendPath
try {
  npm install
  npm run build
} finally {
  Pop-Location
}

if (-not (Test-Path $DistPath)) {
  throw "Build output not found: $DistPath"
}

aws s3 sync $DistPath "s3://$BucketName/" --delete
if ($LASTEXITCODE -ne 0) { throw 'S3 upload failed. Check AWS CLI credentials and bucket name.' }

aws cloudfront create-invalidation --distribution-id $DistributionId --paths '/*'
if ($LASTEXITCODE -ne 0) { throw 'CloudFront invalidation failed. Check the distribution ID and IAM permissions.' }

Write-Host 'Frontend uploaded. Wait a few minutes for CloudFront invalidation to complete.' -ForegroundColor Green
