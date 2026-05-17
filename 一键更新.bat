@echo off
setlocal

cd /d "%~dp0"
set "PROXY=http://127.0.0.1:7890"

echo.
echo Checking Git...
git --version >nul 2>&1
if errorlevel 1 (
  echo Git was not found. Please install Git for Windows first.
  pause
  exit /b 1
)

echo.
echo Current changes:
git status --short

echo.
echo Adding all updates...
git add -A
if errorlevel 1 (
  echo git add failed.
  pause
  exit /b 1
)

git diff --cached --quiet
if not errorlevel 1 (
  echo.
  echo No updates to upload.
  pause
  exit /b 0
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%i"

echo.
echo Creating commit...
git commit -m "Update site %STAMP%"
if errorlevel 1 (
  echo git commit failed.
  pause
  exit /b 1
)

echo.
echo Uploading to GitHub...
git -c http.proxy=%PROXY% -c https.proxy=%PROXY% push origin main
if errorlevel 1 (
  echo.
  echo Upload failed. Make sure your proxy is running on 127.0.0.1:7890.
  echo If your proxy uses another port, edit this file and change PROXY.
  pause
  exit /b 1
)

echo.
echo Done. Vercel will redeploy automatically.
echo https://msu-check.vercel.app/
pause
