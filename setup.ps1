# IONEX Time Tracking Setup Script
Write-Host "IONEX Time Tracking - Setup Script" -ForegroundColor Green
Write-Host "===================================`n" -ForegroundColor Green

# Check if Node.js is installed
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: Node.js is not installed or not in PATH" -ForegroundColor Red
    Write-Host "Please install Node.js from https://nodejs.org/ (v18 or higher)" -ForegroundColor Yellow
    exit 1
}

Write-Host "Node.js version:" -ForegroundColor Cyan
node --version
Write-Host "npm version:" -ForegroundColor Cyan
npm --version
Write-Host ""

# Install root dependencies
Write-Host "Installing root dependencies..." -ForegroundColor Yellow
npm install

# Install backend dependencies
Write-Host "`nInstalling backend dependencies..." -ForegroundColor Yellow
cd backend
npm install

# Generate Prisma client
Write-Host "`nGenerating Prisma client..." -ForegroundColor Yellow
npm run prisma:generate

# Run migrations
Write-Host "`nRunning database migrations..." -ForegroundColor Yellow
npm run prisma:migrate

cd ..

# Install frontend dependencies
Write-Host "`nInstalling frontend dependencies..." -ForegroundColor Yellow
cd frontend
npm install

cd ..

Write-Host "`n===================================" -ForegroundColor Green
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host "===================================`n" -ForegroundColor Green
Write-Host "To start the application, run:" -ForegroundColor Cyan
Write-Host "  npm run dev`n" -ForegroundColor White
Write-Host "This will start:" -ForegroundColor Cyan
Write-Host "  - Backend on http://localhost:3001" -ForegroundColor White
Write-Host "  - Frontend on http://localhost:3000`n" -ForegroundColor White
Write-Host "Note: You'll need to create a user account first." -ForegroundColor Yellow
Write-Host "You can do this via the registration endpoint or Prisma Studio.`n" -ForegroundColor Yellow

