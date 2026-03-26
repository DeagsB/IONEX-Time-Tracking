# Git Push Script for IONEX Time Tracking
# Run this script AFTER installing Git and creating a GitHub repository

Write-Host "IONEX Time Tracking - Git Setup" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""

# Navigate to project root
$projectRoot = "C:\Users\FPCR\Desktop\IONEX Time Tracking Software\IONEX Time Tracking Software"
Set-Location $projectRoot

Write-Host "Current directory: $(Get-Location)" -ForegroundColor Cyan
Write-Host ""

# Check if git is initialized
if (-not (Test-Path ".git")) {
    Write-Host "Initializing git repository..." -ForegroundColor Yellow
    git init
}

# Check git status
Write-Host "Checking git status..." -ForegroundColor Yellow
git status

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Create a repository on GitHub (if you haven't already)" -ForegroundColor White
Write-Host "2. Run: git add ." -ForegroundColor White
Write-Host "3. Run: git commit -m 'Initial commit - IONEX Time Tracking'" -ForegroundColor White
Write-Host "4. Run: git branch -M main" -ForegroundColor White
Write-Host "5. Run: git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git" -ForegroundColor White
Write-Host "6. Run: git push -u origin main" -ForegroundColor White
Write-Host ""
Write-Host "Or run all at once:" -ForegroundColor Cyan
Write-Host "git add . && git commit -m 'Initial commit' && git branch -M main && git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git && git push -u origin main" -ForegroundColor White


