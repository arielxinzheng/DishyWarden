# 告警抽屉功能说明

## 概述
将仪表盘的告警展示方式从嵌入式卡片改为"聚合横幅 + 侧边抽屉"模式，提升用户体验和信息展示效率。

## 设计理念

### 问题
原有设计在仪表盘中直接展开告警卡片，存在以下问题：
- 多个告警时会挤压仪表盘核心指标区域
- 建议措施需要展开/收起，操作繁琐
- 纵向滚动会影响其他指标的可见性

### 解决方案
采用两层信息架构：

**Level 1 - 仪表盘层**
- 显示聚合横幅：`⚠️ 检测到 N 个网络环境异常 [查看详情]`
- 严重告警用红色，普通告警用橙色
- 横幅可点击，不占用过多空间

**Level 2 - 抽屉层**
- 点击横幅后，从屏幕右侧滑出抽屉（占宽度 1/2）
- 抽屉内独立滚动，完整展示所有告警详情
- 按严重程度排序：Critical → Warning → Info
- 完整展示建议措施，无需展开/收起
- 点击蒙版或按 ESC 键关闭

## 实现细节

### 新增组件

#### 1. Drawer 抽屉组件
**文件**: `src/renderer/components/ui/drawer.tsx`

**特性**:
- 从右侧滑入动画 (slideInRight)
- 支持三种宽度：sm (1/3)、md (1/2)、lg (2/3)
- 蒙版背景模糊效果
- ESC 键关闭
- 打开时禁止背景滚动

**API**:
```typescript
interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  width?: 'sm' | 'md' | 'lg';
}
```

#### 2. AlertDrawerContent 告警抽屉内容组件
**文件**: `src/renderer/components/Dashboard/AlertDrawerContent.tsx`

**特性**:
- 接收告警数组，按严重程度自动排序
- Critical 告警：红色边框 + 阴影脉冲效果
- Warning 告警：橙色边框
- Info 告警：蓝色边框
- 完整展示建议措施列表
- 显示触发时间和次数

### 修改组件

#### Dashboard 主组件
**文件**: `src/renderer/components/Dashboard/index.tsx`

**变更**:
1. 添加 `alertDrawerOpen` 状态控制抽屉开关
2. 移除原有的 `AlertList` 组件引用
3. 将告警区域替换为聚合横幅
4. 添加 Drawer 组件并传入 AlertDrawerContent

**横幅逻辑**:
```typescript
// 严重告警判断
const hasCriticalAlerts = activeAlerts.some(a => a.severity === 'critical');

// 横幅文案
hasCriticalAlerts 
  ? '⚠️ 检测到严重告警' 
  : '⚠️ 检测到网络环境异常'
```

## 用户交互流程

```
1. 仪表盘首页
   ↓ (有告警时)
2. 显示聚合横幅
   ├─ 红色 (有 critical)
   └─ 橙色 (仅 warning/info)
   ↓ (点击横幅或"查看详情"按钮)
3. 打开抽屉
   ├─ Critical 告警置顶
   ├─ Warning 告警居中
   └─ Info 告警靠下
   ↓ (查看完毕)
4. 关闭抽屉
   ├─ 点击蒙版
   ├─ 点击右上角 X
   └─ 按 ESC 键
   ↓
5. 回到仪表盘 (无缝回归)
```

## 视觉层级

### 横幅层 (Level 1)
- **高度**: 固定 (约 4rem)
- **位置**: 仪表盘顶部控制区下方
- **内容**: 图标 + 摘要文字 + 数量徽章 + 按钮
- **交互**: hover 高亮，click 打开抽屉

### 抽屉层 (Level 2)
- **宽度**: 50% 视口宽度 (md)
- **高度**: 100% 视口高度
- **位置**: 固定在右侧
- **内容**: 完整告警卡片列表
- **滚动**: 独立滚动容器
- **层级**: z-index 50 (蒙版 40)

## 严重性排序逻辑

```typescript
const severityOrder = { 
  critical: 0,  // 最高优先级
  warning: 1, 
  info: 2 
};

sortedAlerts = alerts.sort((a, b) => 
  severityOrder[a.severity] - severityOrder[b.severity]
);
```

### 排序示例
输入 5 个告警：
- 2x Warning (WiFi弱, 轻度遮挡)
- 2x Critical (失去卫星, 设备断电)
- 1x Info (固件可更新)

输出顺序：
1. ❌ Critical: 失去卫星连接
2. ❌ Critical: 设备断电
3. ⚠️ Warning: WiFi 信号弱
4. ⚠️ Warning: 轻度遮挡
5. ℹ️ Info: 固件可更新

## 动画效果

### 蒙版淡入
```css
@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}
```
**时长**: 300ms
**缓动**: ease-out

### 抽屉滑入
```css
@keyframes slideInRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
```
**时长**: 300ms
**缓动**: ease-out

## 验证方法

### 功能验证
1. 启动应用: `npm run dev`
2. 触发告警 (例如断开网络)
3. 检查仪表盘顶部是否显示聚合横幅
4. 点击横幅，验证抽屉从右侧滑入
5. 验证抽屉内告警按严重程度排序
6. 验证完整建议措施展示
7. 点击蒙版关闭，验证抽屉滑出
8. 按 ESC 键，验证抽屉关闭

### 样式验证
- 严重告警横幅为红色
- 普通告警横幅为橙色
- 抽屉宽度约为屏幕一半
- 抽屉内可独立滚动
- 蒙版有模糊效果
- Critical 告警有红色阴影

### 交互验证
- 横幅 hover 有高亮效果
- 抽屉打开时背景不可滚动
- 关闭抽屉后恢复背景滚动
- 多次打开/关闭抽屉流畅无卡顿

## 技术栈
- **React 18**: Hooks (useState, useEffect)
- **TypeScript**: 类型安全
- **Tailwind CSS 4**: 原子化样式
- **Lucide React**: 图标库
- **CSS Animations**: 原生动画

## 文件变更总结

### 新增
- `src/renderer/components/ui/drawer.tsx` (94 行)
- `src/renderer/components/Dashboard/AlertDrawerContent.tsx` (109 行)

### 修改
- `src/renderer/components/Dashboard/index.tsx` (+55 行, -26 行)
  - 移除 AlertList 引用
  - 添加 Drawer 和 AlertDrawerContent 引用
  - 添加 alertDrawerOpen 状态
  - 替换告警区域为聚合横幅

### 保留
- `src/renderer/components/Dashboard/AlertList.tsx` (保留，告警中心页面仍使用)

## 兼容性说明
- ✅ 不影响"告警中心"页面 (Alerts.tsx)
- ✅ 保持原有告警监听逻辑不变
- ✅ 保持告警数据结构不变
- ✅ 兼容已有的告警规则引擎

## 未来优化方向
1. 添加抽屉宽度可调整功能
2. 支持从抽屉内直接操作告警 (标记已读、忽略等)
3. 添加告警详情展开动画
4. 支持键盘导航 (Tab 切换告警)
5. 添加告警声音提示开关

## 提交信息
```
feat: 仪表盘告警展示改为抽屉模式

将告警卡片改为简洁的聚合横幅 + 侧边抽屉展示方式
```

**Commit Hash**: 3d3bc52