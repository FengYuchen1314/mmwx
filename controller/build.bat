@echo off
REM 后端打包脚本 (Windows)
setlocal enabledelayedexpansion

echo ========================================
echo 开始构建后端项目
echo ========================================

REM 设置变量
set BUILD_DIR=build
set OUTPUT_DIR=%BUILD_DIR%\release

REM 清理旧的构建目录
if exist "%BUILD_DIR%" (
    echo 清理旧的构建文件...
    rmdir /s /q "%BUILD_DIR%"
)

REM 1. 构建 Go 后端 (Linux)
echo.
echo [1/2] 构建 Linux 版本后端...
set GOOS=linux
set GOARCH=amd64
go build -ldflags="-s -w" -o %BUILD_DIR%\mmwx-linux-amd64 ./cmd/server
if errorlevel 1 (
    echo Linux 后端构建失败！
    exit /b 1
)
echo Linux 后端构建完成 ✓

REM 2. 构建 Go 后端 (Windows)
echo.
echo [2/2] 构建 Windows 版本后端...
set GOOS=windows
set GOARCH=amd64
go build -ldflags="-s -w" -o %BUILD_DIR%\mmwx-windows-amd64.exe ./cmd/server
if errorlevel 1 (
    echo Windows 后端构建失败！
    exit /b 1
)
echo Windows 后端构建完成 ✓

REM 4. 准备发布文件
echo.
echo 准备发布文件...
mkdir "%OUTPUT_DIR%\windows" 2>nul
mkdir "%BUILD_DIR%\data" 2>nul
mkdir "%BUILD_DIR%\subscribes" 2>nul

REM 复制 Windows 版本到 release 目录
copy "%BUILD_DIR%\mmwx-windows-amd64.exe" "%OUTPUT_DIR%\windows\" >nul
if exist "data" (
    xcopy "data" "%OUTPUT_DIR%\windows\data\" /E /I /Y >nul 2>&1
)
if exist "subscribes" (
    xcopy "subscribes" "%OUTPUT_DIR%\windows\subscribes\" /E /I /Y >nul 2>&1
)
if exist "config" (
    xcopy "config" "%OUTPUT_DIR%\windows\config\" /E /I /Y >nul 2>&1
)

REM 复制必要的配置文件到 build 根目录
if exist "data" (
    xcopy "data" "%BUILD_DIR%\data\" /E /I /Y >nul 2>&1
)
if exist "subscribes" (
    xcopy "subscribes" "%BUILD_DIR%\subscribes\" /E /I /Y >nul 2>&1
)

echo.
echo ========================================
echo 构建完成！
echo ========================================
echo.
echo 输出文件:
echo   - Linux:   %BUILD_DIR%\mmwx-linux-amd64
echo   - Windows: %BUILD_DIR%\mmwx-windows-amd64.exe
echo   - Release: %OUTPUT_DIR%\windows\
echo.
