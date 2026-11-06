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
| 推荐范围画在圆环上 | 灰/绿 donut 扇带（未进带灰、进带绿）+ 外圈亮弧标记位置 | `GaugeDial.tsx` + `dialGeometry.ts` |
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
| 扇带半径 | 72 / 58 | 100 / 86 |
| 外圈目标弧 | 79 | 106 |
| 刻度半径 | 86 | 116 |
| 指针长度 | 55（停在带内缘之前） | 83 |
| 圆心牌 | (100, 100) w=100 | (142, 44) w=96 |

仰角盘的牌子坐标不是随手填的：推荐带（仰角 71–81° ⇒ 罗盘 9–19°）最右只到 x≈80，
刻度点最小 y = cy - tickR = 58，且落在 x < 94 的一段，所以 **x 94–190 / y 28–60**
是这张盘上唯一既不压带、也不压刻度、还装得下「推荐 71.0°–81.0°」整行的矩形。
改半径时这段结论要重算。

「✅ 已对齐」提示是标题行的 **flex 兄弟节点**，不是浮层：放 fixed（顶部或底部）
都会压住内容 —— 顶部压 h1，底部盖住说明卡。放进行内后它永远不会覆盖任何东西，
隐藏时保留占位，标题也不会跳动。

## 6. 「扇带看不见」这件事（真机实测发现）

第一版按需求写完，浏览器里能看到扇带，**Electron 真机上却完全找不到**。查下来是两件事叠加：

1. **DishyMock 上报的 `desiredBoresight*` 恒等于当前读数**（实测方位 0.5°/0.5°、
   仰角 65.1°/65.1°），于是指针永远正好压在推荐带正中，两者又是同一个绿，
   屏幕上只剩一根绿线。
2. **指针长度 = 扇带外半径**，指针线 + 端点圆点把 10° 宽的带整个盖住。

所以「彩色扇带是推荐范围」这句话虽然没写错，用户却找不到扇带。改法：

- **指针缩到带内缘就停**（compass 55 < 带内缘 58），扇带本体完整露出；
- **外圈加一段粗亮弧**（`arcPath`，半径在指针长度之外），一眼定位推荐区在圆周哪；
- 扇带本体描边加粗（1.6）并提高不透明度，灰色 0.14→0.22、绿色 0.22→0.34；
- 说明卡加了**颜色图例**（灰/绿/橙三块色片），文案改成与盘面对应
  （「外圈亮弧标出位置，内圈扇带就是推荐范围本身」）；
- 设备没上报期望值时，文案不再承诺扇带，改说「设备未上报期望值，本页不画推荐范围」。

顺带发现 `tiltAngleDeg = 24.799999237060547` —— 正是需求里举的那个噪声例子，
页面显示为「24.8°」，格式化确实生效。

## 7. 验证

```bash
npx vitest run src/renderer/components/Alignment     # 37 passed
npx vitest run src/core/dishClient.desired.test.ts    # 10 passed
npx tsc --noEmit -p tsconfig.json                    # Alignment 相关 0 错误
npm run dev                                          # 打开 /alignment
```

**注意：mock 数据的偏差只有 ±1°**（`useDish.tsx` 里 `(Math.random()-0.5)*2`），
永远落在 ±5° 带内，所以浏览器/Electron-mock 下**看不到**未对齐态。要验证橙色指针、
灰色扇带、引导文案与箭头方向，得临时加一个入口页，把 `rotationModel(10, 30)` /
`elevationModel(60, 76)` 这类强制模型直接喂给 `<GaugeDial>`（验证完删掉即可，
别把临时入口页提交进仓库）。

真机数据可以直接从 DishyMock 取：

```bash
# node .tmp-dump-status.mjs（临时脚本，勿提交）
alignmentStats.desiredBoresightAzimuthDeg   # 实测 0.5
alignmentStats.desiredBoresightElevationDeg # 实测 65.0999984741211
```

## 8. 期望值缺失时的「假推荐正北」（已修）

`dishClient.ts` 原来这样映射期望朝向：

```ts
desiredBoresightAzimuthDeg: num(alignment.desiredBoresightAzimuthDeg,
                                 prev?.alignmentStats?.desiredBoresightAzimuthDeg ?? 0),
```

`num()` 解析失败会兜成 **0**，而 **0 是完全合法的方位角（正北）**。后果：

- 设备不报期望朝向 → 拿到 0 → 校准页以为「推荐正北」，
  天线实际指向 135° 时给出「向西旋转 135°」这种**错误引导**；
- 页面里「设备未上报推荐朝向」这条分支永远走不到。

改成：

```ts
desiredBoresightAzimuthDeg:
  parseFiniteNumber(alignment.desiredBoresightAzimuthDeg) ??
  prev?.alignmentStats?.desiredBoresightAzimuthDeg,
```

要点：

- 缺失 = `undefined`（「没有期望值」），**上报 0 仍然是 0**（推荐正北是合法值）——
  两者可区分，因为 proto loader 用的是 `defaults: false`（`dishGrpc.ts`），
  设备不报的字段压根不会出现在响应里；
- 本帧缺失时沿用上一帧的值，设备抖动不会让推荐范围忽有忽无；
- `parseFiniteNumber` 单独抽成导出函数并配了单测（`src/core/dishClient.desired.test.ts`，
  10 个用例，含直接驱动 `parseStatus` 的端到端断言）。

## 9. 已知遗留

1. 仰角盘的刻度只有点、没有数字标签，读数要靠盘心「推荐 71.0°–81.0°」。
2. DishyMock 把期望值设成当前值，所以真机上永远是「已对齐」；要看未对齐态
   必须用真实天线或改 mock 数据。
