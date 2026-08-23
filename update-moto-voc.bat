@echo off
setlocal EnableExtensions
set "PROJECT=C:\Users\Noxo\Desktop\vocal\moto-voc"

echo ========================================
echo        MOTO VOC - MISE A JOUR
echo ========================================
echo.

if not exist "%PROJECT%\.git" (
  echo [ERREUR] Le dossier n'est pas un depot Git :
  echo %PROJECT%
  pause
  exit /b 1
)

cd /d "%PROJECT%"

echo [1/4] Recuperation des nouvelles versions...
git fetch origin
if errorlevel 1 goto :error

echo [2/4] Mise a jour du code...
git pull --ff-only origin main
if errorlevel 1 (
  echo.
  echo [INFO] La branche main n'est peut-etre pas votre branche courante.
  git pull --ff-only
  if errorlevel 1 goto :error
)

echo [3/4] Installation des dependances...
call npm.cmd install
if errorlevel 1 goto :error

echo [4/4] Mise a jour terminee.
echo.
echo Moto Voc est a jour.
echo Lancez ensuite : npm.cmd start
echo.
pause
exit /b 0

:error
echo.
echo [ERREUR] La mise a jour a echoue.
echo Verifiez le message ci-dessus.
pause
exit /b 1
