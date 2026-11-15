# Screenshots

README 里引用的截图放在这个目录：

| 文件 | 对应位置 | 状态 |
|---|---|---|
| `dashboard.png` | README「仪表盘」格 | ⏳ 待补 |
| `obstruction.png` | README「遮挡图」格 | ⏳ 待补 |

## 怎么补

从**真实运行会话**截屏（不要用示意图 —— README 里明确写了「截图取自真实
运行会话，非示意图」）。

推荐尺寸与内容：

### `dashboard.png`

- 仪表盘首屏，**含至少一张指标卡和一张图表**
- 状态条（连接状态色块竖条）要可见 —— 这是本项目的标志性视觉
- 用真实设备或 DishyMock 模拟的数据，不要空白状态

### `obstruction.png`

- 障碍图页面（半球极坐标投影）
- **要能看到有内容的遮挡图**，不是空的半球
- 侧边的"刚刚恢复"卡片、指标卡若能同框更好

## 注意事项

- 宽高比建议 16:10 或 16:9（README 是两格并排表格）
- 文件体积控制在 500 KB 内 —— 公开仓库的 clone 速度
- **不要**在截图里露出：真实 IP、账号、token、坐标、主机名、序列号
  （Starlink 设备序列号属于个人信息）
- 文件名必须与上表完全一致 —— README 的 5 个语言版本都引用这两个路径，
  改名字要同步改 `docs/readme/*.md` 并重新跑 `npm run docs:generate`

## 验证

补完图后：

```bash
npm run docs:generate   # 重新生成 5 语言 README
npm run docs:check      # 应显示"10 个多语言文档与源文件一致"
```

GitHub 上图片是相对路径（`docs/screenshots/xxx.png`），从仓库根目录看是
`README.md` 所在层级，所以放在这里即可。
