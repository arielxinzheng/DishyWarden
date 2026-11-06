# 变更记录：校准页图形化引导

**日期**: 2026-11-06
**提交**: `dc684fa`
**范围**: `src/renderer/components/Alignment/`（新增 9 个文件）、`src/renderer/pages/AlignmentPage.tsx`、`src/renderer/hooks/useDish.tsx`
**状态**: 浏览器已验证（Electron 真机待验）

> 相关总览见 [`DEVELOPMENT-STATUS.md`](./DEVELOPMENT-STATUS.md)。

---

## 1. 需求 → 实现对照

| 需求 | 实现 | 位置 |
|---|---|---|
| 角度统一 `toFixed(1)` | `formatDeg` / `formatSignedDeg`，`-0` 与 NaN 有兜底 | `format.ts` |
| 枚举翻译成人话 | `describeAttitudeState`，5 个状态 + 未知值兜底 | `attitudeState.ts` |
| 推荐范围画在圆环上 | 灰/绿donut扇带，未进带灰、进带绿 | `GaugeDial.tsx` + `dialGeometry.ts` |
| 指针相对目标的位置 → 引导 | 圆心牌「向东旋转 20.0°」/「需抬高 16.0°」+ 环外切向三角 | `alignmentGuidance.ts` + `GaugeDial.tsx` |
| 进带即正反馈 | 指针橙→绿；两轴都进带时弹「✅ 已对齐」3.2s | `dialGeometry.ts` + `AlignmentFlash.tsx` |

## 2. 顺带修掉的 bug

旧实现判 `attitudeEstimationState === 'VALID'`，而这个值**在 dish proto 里不存在**
（真实枚举是 `FILTER_RESET / FILTER_INITIALIZING / FILTER_CONVERGED /
FILTER_CONVERGENCE_WARNING / INVALID_STATE`）。于是真机永远判「未对齐」，
页面还把 `姿态估计: FILTER_CONVERGED` 原样抛给用户。

`useDish.tsx` 的 mock 也跟着从 `'VALID'` 改成 `'FILTER_CONVERGED'`，否则浏览器里
看不到正确分支。`attitudeState.test.ts` 有回归用例锁死这一点。

## 3. 关键决策

- **容差 ±5°**（`DEFAULT_TOLERANCE_DEG`）：终端有相控阵电扫，机械差几度不影响链路；
  带太宽用户会以为「随便摆都行」。
- **TILT 盘指针取 `boresightElevationDeg`**，而不是 `tiltAngleDeg`：推荐带
  （`desiredBoresightElevationDeg`）与 boresight 同坐标系，拿物理倾斜角去比会得到
  一个恒定的假偏差。`tiltAngleDeg` 仍在参数表里如实展示。
- **「已对齐」要三个条件**：滤波器收敛 + 方位进带 + 仰角进带。滤波器没收敛时指针
  本身在漂，此时催用户「向东转 15°」是最容易挨骂的错误引导 —— 所以只显示「正在校准」。
  单轴进带只有指针变色 + 盘心「已对齐」，不弹全页浮层。
- **圆心牌压在最上层**（绘制顺序：带 → 刻度 → 指针 → 引导牌 → 箭头）：半透明底会让
  数字和指针糊在一起。

## 4. 角度与坐标约定

一律用**罗盘角**：0° = 正上方，顺时针为正（N→E→S→W）。

```
方位角盘：compass = azimuth
仰角盘：  compass = 90 - elevation      // 仰角 0° = 水平 = 罗盘 90°；90° = 头顶 = 罗盘 0°
```

两个盘共用 `polar()` / `donutSectorPath()`，不再各写一份三角函数（旧版两盘对同一台
设备能给出相反结论）。扇带用 **(起点, 正跨度)** 而非两个端点，天然支持跨 0°
（例如推荐带 -3°..7°）。

## 5. 盘面几何取值

| | 方位角盘 | 仰角盘（象限） |
|---|---|---|
| 圆心 | (100, 100) | (46, 174) |
| 环半径 | 76 / 52 | 104 / 80 |
| 刻度半径 | 82 | 111 |
| 圆心牌 | (100, 100) w=100 | (142, 44) w=96 |

仰角盘的牌子坐标不是随手填的：推荐带（仰角 71–81° ⇒ 罗盘 9–19°）最右只到 x≈80，
刻度点最小 y = cy - tickR = 63，所以 **x 94–190 / y 28–60** 是这张盘上唯一既不压带、
也不压刻度、还装得下「推荐 71.0°–81.0°」整行的区域。改半径时这段结论要重算。

「✅ 已对齐」浮层固定在**底部**居中：放顶部会正好压在页面 h1 上。

## 6. 验证

```bash
npx vitest run src/renderer/components/Alignment     # 29 passed
npx tsc --noEmit -p tsconfig.json                    # Alignment 相关 0 错误
npm run dev                                          # 打开 /alignment
```

**注意：mock 数据的偏差只有 ±1°**（`useDish.tsx` 里 `(Math.random()-0.5)*2`），
永远落在 ±5° 带内，所以浏览器/Electron-mock 下**看不到**未对齐态。要验证橙色指针、
灰色扇带、引导文案与箭头方向，得临时加一个入口页，把 `rotationModel(10, 30)` /
`elevationModel(60, 76)` 这类强制模型直接喂给 `<GaugeDial>`（验证完删掉即可，
别把临时入口页提交进仓库）。

## 7. 已知遗留

1. `dishClient.ts` 把缺失的 `desiredBoresight*` 兜成 `0` 而不是 `undefined`
   （`num(x, prev ?? 0)`），于是新页面的「设备未上报推荐朝向」分支在真机路径上
   基本不可达，会退化成「以 0° 为中心的扇带 + 向西旋转 135°」这种错误引导。
   属于既有映射，未在本次改动内。
2. 仰角盘的刻度只有点、没有数字标签，读数要靠盘心「推荐 71.0°–81.0°」。
