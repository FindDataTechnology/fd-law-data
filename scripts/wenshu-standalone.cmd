@echo off
rem Launch the STANDING browser for wenshu (CDP 9223) on Windows — the browser
rem whose login state the crawler rides. Windows counterpart of
rem wenshu-standalone.sh: a NON-default --user-data-dir is mandatory (Chromium
rem 136+ refuses --remote-debugging-port on the default profile). Edge is the
rem preinstalled Chromium on windows-admin; set WENSHU_BROWSER to point at a
rem real Chrome if one is installed later.
rem
rem Leave the window open (minimizing is fine). Closing it ends the wenshu
rem session; the nightly supervisor logs a loud SESSION INVALID line until a
rem human logs in again in this window.
setlocal
set "PROFILE=%USERPROFILE%\wenshu-nightly\browser-profile"
set "PORT=%WENSHU_CDP_PORT%"
if "%PORT%"=="" set "PORT=9223"
set "BROWSER=%WENSHU_BROWSER%"
if "%BROWSER%"=="" set "BROWSER=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if "%WENSHU_HOME_URL%"=="" set "WENSHU_HOME_URL=https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html"

if not exist "%PROFILE%" mkdir "%PROFILE%"
start "" "%BROWSER%" --user-data-dir="%PROFILE%" --remote-debugging-port=%PORT% --no-first-run --no-default-browser-check --window-size=1300,900 "%WENSHU_HOME_URL%"
echo standing browser requested: CDP http://localhost:%PORT%  profile %PROFILE%
endlocal
