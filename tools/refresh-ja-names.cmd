@echo off
rem Japanese names/art lookups that GitHub's servers cannot do (Bulbapedia blocks them). Run from this PC
rem whenever new Japanese sets appear; results are cached and pushed, and the nightly job applies them.
cd /d "%~dp0.."
node data-pipeline\build.mjs --langs ja --skip-home || exit /b 1
node tools\jp-prices.mjs || exit /b 1
node tools\fill-ja-art.mjs || exit /b 1
node tools\ja-names.mjs || exit /b 1
node tools\ja-official-names.mjs || exit /b 1
git add data-pipeline\cache\ja-art data-pipeline\cache\tcgcsv-ja.json data-pipeline\cache\ja
git commit -m "Japanese name/art lookups refreshed from PC" || echo Nothing new.
git pull --rebase -X ours && git push
echo Done.
pause
