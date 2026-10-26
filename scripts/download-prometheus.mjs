#!/usr/bin/env node

/**
 * 下载 Prometheus 二进制文件
 * 
 * 自动检测平台并下载对应的 Prometheus 版本
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { pipeline } from 'stream';
import { createGunzip } from 'zlib';
import tar from 'tar';

const streamPipeline = promisify(pipeline);

const PROMETHEUS_VERSION = '2.48.1';
const DOWNLOAD_DIR = path.join(process.cwd(), 'resources', 'prometheus');

const PLATFORM_MAP = {
  darwin: {
    arm64: `prometheus-${PROMETHEUS_VERSION}.darwin-arm64`,
    x64: `prometheus-${PROMETHEUS_VERSION}.darwin-amd64`,
  },
  linux: {
    arm64: `prometheus-${PROMETHEUS_VERSION}.linux-arm64`,
    x64: `prometheus-${PROMETHEUS_VERSION}.linux-amd64`,
  },
  win32: {
    x64: `prometheus-${PROMETHEUS_VERSION}.windows-amd64`,
  },
};

async function download(url, dest) {
  console.log(`Downloading: ${url}`);
  console.log(`Destination: ${dest}`);
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    
    https.get(url, (response) => {
      if (response.statusCode === 302 || response.statusCode === 301) {
        // 处理重定向
        https.get(response.headers.location, (redirectResponse) => {
          redirectResponse.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        }).on('error', reject);
      } else {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      }
    }).on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function extractTarGz(archivePath, extractDir) {
  console.log(`Extracting: ${archivePath}`);
  
  await tar.x({
    file: archivePath,
    cwd: extractDir,
    strip: 1, // 去掉顶层目录
  });
  
  console.log('Extraction complete');
}

async function downloadPrometheus(platform, arch) {
  const platformKey = PLATFORM_MAP[platform]?.[arch];
  
  if (!platformKey) {
    throw new Error(`Unsupported platform: ${platform}-${arch}`);
  }

  const tarballName = `${platformKey}.tar.gz`;
  const downloadUrl = `https://github.com/prometheus/prometheus/releases/download/v${PROMETHEUS_VERSION}/${tarballName}`;
  
  const platformDir = path.join(DOWNLOAD_DIR, platform);
  await fs.promises.mkdir(platformDir, { recursive: true });
  
  const archivePath = path.join(platformDir, tarballName);
  
  // 下载
  await download(downloadUrl, archivePath);
  
  // 解压
  await extractTarGz(archivePath, platformDir);
  
  // 删除压缩包
  await fs.promises.unlink(archivePath);
  
  // 设置可执行权限（Unix-like 系统）
  if (platform !== 'win32') {
    const binaryPath = path.join(platformDir, 'prometheus');
    await fs.promises.chmod(binaryPath, 0o755);
  }
  
  console.log(`✅ Prometheus ${PROMETHEUS_VERSION} for ${platform}-${arch} downloaded successfully`);
}

async function main() {
  console.log('=== Downloading Prometheus binaries ===\n');
  
  const platforms = [
    { platform: 'darwin', arch: 'arm64' },
    { platform: 'darwin', arch: 'x64' },
    { platform: 'linux', arch: 'x64' },
    { platform: 'win32', arch: 'x64' },
  ];
  
  for (const { platform, arch } of platforms) {
    try {
      console.log(`\nDownloading for ${platform}-${arch}...`);
      await downloadPrometheus(platform, arch);
    } catch (error) {
      console.error(`❌ Failed to download for ${platform}-${arch}:`, error.message);
    }
  }
  
  console.log('\n=== Download complete ===');
}

main().catch(console.error);