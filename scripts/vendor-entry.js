/*
 * vendor 运行库打包入口。
 * scripts/prepare-runtime.cjs 用 esbuild 把本文件打包成 vendor/runtime.bundle.js（IIFE、压缩、本地加载，不依赖 CDN）。
 * 加载顺序要求：live2dcubismcore.min.js 必须先于本 bundle 执行——
 * @laplace.live/pixijs-live2d 入口在 window.Live2DCubismCore 缺失时会直接抛错。
 */

import * as PIXI from 'pixi.js';
import 'pixi.js/unsafe-eval'; // 官方 CSP 适配：使用不依赖 JS eval 的 shader/uniform 同步实现。
import { Live2DModel, Live2DPlugin } from '@laplace.live/pixijs-live2d';

window.PIXI = PIXI;
window.Live2DModel = Live2DModel;
PIXI.extensions.add(Live2DPlugin);

// 用 pixi 共享 Ticker 驱动模型动作/物理更新（官方 README 用法）。
Live2DModel.registerTicker(PIXI.Ticker);
