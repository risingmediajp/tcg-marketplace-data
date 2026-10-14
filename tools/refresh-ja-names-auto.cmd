@echo off
rem Unattended version of refresh-ja-names.cmd (weekly scheduled task "TCG Marketplace JA names").
rem Log: data-pipeline\refresh-ja-names.log
setlocal
cd /d "%~dp0.."
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.18.0-win-x64;C:\Program Files\Git\cmd;%PATH%"
set LOG=data-pipeline\refresh-ja-names.log
echo ===== %date% %time% ===== >> "%LOG%"
(
  node data-pipeline\build.mjs --langs ja --skip-home && node tools\jp-prices.mjs && node tools\fill-ja-art.mjs && node tools\ja-names.mjs && node tools\ja-official-names.mjs
  git add data-pipeline\cache\ja-art data-pipeline\cache\tcgcsv-ja.json data-pipeline\cache\ja
  git commit -m "Japanese name/art lookups refreshed (scheduled)" || echo Nothing new.
  git pull --rebase -X ours && git push
) >> "%LOG%" 2>&1
echo ===== done %time% ===== >> "%LOG%"
