'use strict';
/*
 * 准备本项目运行库（vendor/）与 Electron 二进制。
 * - vendor/runtime.bundle.js 由本地依赖（pixi.js + @laplace.live/pixijs-live2d）经 esbuild 打包，每次运行都重新构建，保证与 package.json 锁定版本一致。
 * - live2dcubismcore.min.js 为 Live2D 专有运行时（git 忽略，不入库），从匹配 CubismWebFramework 5-r.5 的官方 Core 06 地址获取；自动替换不兼容的旧 Core。
 * - 旧版 pixi 6 / pixi-live2d-display 0.4.0 的 vendor 产物会被自动清理。
 * - 任何下载失败都会给出可操作的中文错误（含所有尝试过的地址与手动放置方法）。
 * 用法：npm install && npm run prepare-runtime
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENDOR_DIR = path.join(PROJECT_ROOT, 'vendor');
const BUNDLE_PATH = path.join(VENDOR_DIR, 'runtime.bundle.js');
const BUNDLE_ENTRY = path.join(__dirname, 'vendor-entry.js');
const MAX_BYTES = 300 * 1024 * 1024;

// Cubism Core 是 Live2D 专有运行时，只从官方地址获取；其他运行库一律来自 package.json 锁定的 npm 依赖。
const CORE_TARGET = {
  name: 'live2dcubismcore.min.js',
  urls: ['https://cubism.live2d.com/sdk-web/core/06/live2dcubismcore.min.js'],
  marker: 'Live2DCubismCore',
  minSize: 100 * 1024,
};

function fail(message) {
  console.error('\n[prepare-runtime] 失败：' + message);
  process.exit(1);
}

function download(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'big-fat-fish-prepare-runtime' } }, (res) => {
      if (res.statusCode >= 301 && res.statusCode <= 308 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) {
          req.destroy(new Error(`文件超过 ${MAX_BYTES} 字节上限，内容不像预期的脚本文件`));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('连接超时（60 秒无数据）')));
    req.on('error', reject);
  });
}

function looksWrong(content, marker) {
  const head = content.subarray(0, 64).toString('utf8').trimStart();
  if (head.startsWith('<')) return '下载到的是 HTML 页面而不是脚本（常见于网络拦截页）';
  if (!content.toString('utf8').includes(marker)) return `内容缺少预期的标识 “${marker}”`;
  return null;
}

function checkDependencies() {
  for (const name of ['esbuild', 'pixi.js', '@laplace.live/pixijs-live2d']) {
    if (!fs.existsSync(path.join(PROJECT_ROOT, 'node_modules', name, 'package.json'))) {
      fail(`未找到依赖 ${name}。请先在项目目录执行 npm install，再运行本脚本。`);
    }
  }
}

/* 本地打包 pixi.js v8 + @laplace.live/pixijs-live2d（内含 CubismWebFramework 5-r.5 镜像）。
 * 每次都重新构建，避免 vendor 里的产物与锁定依赖脱节。 */
function buildRuntimeBundle() {
  const esbuild = require(path.join(PROJECT_ROOT, 'node_modules', 'esbuild'));
  const result = esbuild.buildSync({
    entryPoints: [BUNDLE_ENTRY],
    outfile: BUNDLE_PATH,
    bundle: true,
    minify: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    legalComments: 'external',
    logLevel: 'warning',
    // @pixi/sound 是可选 peer，本项目不使用动作音/口型音频，保持外部引用即可（渲染端不会触发）。
    external: ['@pixi/sound'],
  });
  const content = fs.readFileSync(BUNDLE_PATH);
  const wrong = looksWrong(content, 'Live2DModel');
  if (wrong || content.length < 200 * 1024) {
    fail(`vendor/runtime.bundle.js 构建结果异常（${wrong || `仅 ${content.length} 字节`}）。`);
  }
  console.log(`  已构建 vendor/runtime.bundle.js（${content.length} 字节）`);
  return result;
}

/* 把打包进 vendor/runtime.bundle.js 的各依赖许可文本复制到 vendor/licenses/，随库保持准确。 */
function copyLicenses() {
  const licensesDir = path.join(VENDOR_DIR, 'licenses');
  fs.mkdirSync(licensesDir, { recursive: true });
  const modulesDir = path.join(PROJECT_ROOT, 'node_modules');
  const licenses = [
    ['pixi.js/LICENSE', 'pixi.js-LICENSE'],
    ['@laplace.live/pixijs-live2d/LICENSE', 'pixijs-live2d-LICENSE'],
    // 引擎内以原始镜像方式打包了 Live2D CubismWebFramework（5-r.5），遵循 Live2D 开源软件许可。
    ['@laplace.live/pixijs-live2d/vendor/cubism/LICENSE.md', 'pixijs-live2d-cubism-framework-LICENSE.md'],
  ];
  for (const [from, to] of licenses) {
    const source = path.join(modulesDir, ...from.split('/'));
    const target = path.join(licensesDir, to);
    if (!fs.existsSync(source)) fail(`未找到许可文件 ${from}，无法维护准确的第三方声明。`);
    fs.copyFileSync(source, target);
    console.log(`  已复制许可 ${from} → vendor/licenses/${to}`);
  }
}

/* 清理旧渲染库（pixi 6.5.10 + pixi-live2d-display 0.4.0，其内置 Cubism 4 框架无法正确渲染 Cubism 5 moc3）。 */
function cleanupLegacyVendor() {
  const legacy = [
    path.join(VENDOR_DIR, 'pixi.min.js'),
    path.join(VENDOR_DIR, 'pixi-live2d-display', 'cubism4.min.js'),
  ];
  for (const file of legacy) {
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    console.log(`  已移除旧运行库 ${path.relative(PROJECT_ROOT, file)}`);
  }
  const legacyDir = path.join(VENDOR_DIR, 'pixi-live2d-display');
  if (fs.existsSync(legacyDir)) {
    try { fs.rmdirSync(legacyDir); } catch { /* 非空目录留给用户手动处理 */ }
  }
}

function checkCoreVersionGate(content) {
  const wrong = content.length < CORE_TARGET.minSize ? '文件过小' : looksWrong(content, CORE_TARGET.marker);
  if (wrong) return wrong;
  return content.toString('utf8').includes('csmGetRenderOrders')
    ? null : '缺少 Core 06 的 render-order API，与 CubismWebFramework 5-r.5 不兼容';
}

function ensureCore() {
  const outPath = path.join(VENDOR_DIR, CORE_TARGET.name);
  if (fs.existsSync(outPath)) {
    const content = fs.readFileSync(outPath);
    const wrong = checkCoreVersionGate(content);
    if (wrong) {
      console.log(`  已存在的 vendor/${CORE_TARGET.name} 无效（${wrong}），重新下载…`);
      fs.unlinkSync(outPath);
    } else {
      console.log(`  vendor/${CORE_TARGET.name} 已存在且兼容 CubismWebFramework 5-r.5，跳过`);
      return;
    }
  }
  return fetchCore(outPath);
}

async function fetchCore(outPath) {
  const attempted = [];
  for (const url of CORE_TARGET.urls) {
    attempted.push(url);
    let content;
    try {
      content = await download(url);
    } catch (err) {
      console.warn(`  下载失败 ${url} → ${err.message}`);
      continue;
    }
    if (content.length < CORE_TARGET.minSize) {
      console.warn(`  内容过小（${content.length} 字节）${url}`);
      continue;
    }
    const wrong = checkCoreVersionGate(content);
    if (wrong) {
      console.warn(`  ${wrong} ${url}`);
      continue;
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content);
    console.log(`  已下载 ${CORE_TARGET.name}（${content.length} 字节）← ${url}`);
    return;
  }
  fail(
    `无法获取 vendor/${CORE_TARGET.name}。\n` +
    `尝试过的地址：\n  ${attempted.join('\n  ')}\n` +
    `请检查网络/代理后重试；或手动从 Cubism SDK for Web（https://www.live2d.com/en/sdk/download/web/）下载 live2dcubismcore.min.js，保存为 vendor/${CORE_TARGET.name} 后重新运行本脚本。`
  );
}

function ensureElectronBinary() {
  const pkgDir = path.join(PROJECT_ROOT, 'node_modules', 'electron');
  const exe = path.join(pkgDir, 'dist', 'electron.exe');
  if (fs.existsSync(exe)) {
    console.log('  Electron 二进制已存在，跳过');
    return;
  }
  if (!fs.existsSync(path.join(pkgDir, 'package.json'))) {
    fail('未找到 node_modules/electron。请先在项目目录执行 npm install，再运行本脚本。');
  }
  console.log('  Electron 二进制缺失，运行官方 install.js 下载…');
  const env = { ...process.env };
  if (!env.ELECTRON_CACHE) {
    env.ELECTRON_CACHE = path.join(PROJECT_ROOT, '.local', 'electron-cache');
  }
  if (!env.ELECTRON_MIRROR && !env.npm_config_ELECTRON_MIRROR) {
    env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
    console.log('  未设置 ELECTRON_MIRROR，默认使用国内镜像 https://npmmirror.com/mirrors/electron/');
  }
  const result = spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], {
    stdio: 'inherit',
    cwd: pkgDir,
    env,
  });
  if (result.error || result.status !== 0 || !fs.existsSync(exe)) {
    fail('Electron 二进制下载失败。请检查网络后重试；也可手动设置环境变量 ELECTRON_MIRROR 指向可用镜像。');
  }
  console.log('  Electron 二进制下载完成');
}

(async () => {
  console.log('[prepare-runtime] 检查依赖与运行库…');
  checkDependencies();
  buildRuntimeBundle();
  copyLicenses();
  cleanupLegacyVendor();
  await ensureCore();
  ensureElectronBinary();
  console.log('[prepare-runtime] 完成。');
})().catch((err) => fail(err && err.stack ? err.stack : String(err)));
